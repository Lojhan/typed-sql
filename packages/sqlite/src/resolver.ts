import type {
  CallExpression,
  Expression,
  Identifier,
  SelectItem,
  SelectStatement,
  SourceRange,
  SqlDiagnostic,
  Statement,
  TableReference,
  WithClause,
} from "@typed-sql/ast";
import { ParameterCollector, type ResolvedParameter, ResolverSchemaIndex, unionTypeLiterals } from "@typed-sql/core";
import type { ColumnSnapshot, FunctionSnapshot, SchemaSnapshot, TableSnapshot } from "@typed-sql/schema";
import {
  defaultSqliteTypePolicy,
  isKnownSqliteType,
  mapSqliteCastType,
  type SqliteTypePolicy,
  sqliteFlexibleType,
} from "./type-policy.js";

interface ResolvedType {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

interface Relation {
  readonly alias: string;
  readonly table: TableSnapshot;
  nullable: boolean;
}

interface Scope {
  readonly relations: Relation[];
  readonly usingColumns: Map<string, ResolvedType>;
  readonly outer?: Scope;
}

export interface ResolvedSqliteColumn extends ResolvedType {
  readonly name: string;
  readonly range: SourceRange;
}

export interface ResolvedSqliteQuery {
  readonly columns: readonly ResolvedSqliteColumn[];
  readonly parameters: readonly ResolvedParameter[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly resultKind: "rows" | "command";
}

export interface ResolveSqliteOptions {
  readonly typePolicy?: SqliteTypePolicy;
  readonly strictExpressions?: boolean;
}

const numericTypes = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "bit",
  "year",
]);
const comparisonOperators = new Set([
  "=",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "IS",
  "IS NOT",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
  "LIKE",
  "NOT LIKE",
  "AND",
  "OR",
]);

function name(identifier: Identifier): string {
  return identifier.quoted ? identifier.name : identifier.name.toLowerCase();
}

function normalized(databaseType: string): string {
  return databaseType
    .trim()
    .toLowerCase()
    .replace(/\s+unsigned$/u, "")
    .replace(/\(.*/u, "");
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: SqliteTypePolicy;
  readonly #strict: boolean;
  readonly #diagnostics: SqlDiagnostic[] = [];
  readonly #parameters = new ParameterCollector();
  readonly #index: ResolverSchemaIndex;

  constructor(schema: SchemaSnapshot, options: ResolveSqliteOptions) {
    this.#schema = schema;
    this.#index = ResolverSchemaIndex.for(schema);
    this.#policy = options.typePolicy ?? defaultSqliteTypePolicy;
    this.#strict = options.strictExpressions ?? true;
  }

  resolve(statement: Statement): ResolvedSqliteQuery {
    if (this.#schema.dialect !== "sqlite")
      this.#diagnostic("TSQ007", `SQLite resolver cannot analyze ${this.#schema.dialect}`, statement.range);
    const result = this.#statement(statement, undefined, new Map());
    return {
      ...result,
      parameters: this.#parameters.values(),
      diagnostics: this.#diagnostics,
    };
  }

  #statement(
    statement: Statement,
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): Omit<ResolvedSqliteQuery, "diagnostics" | "parameters"> {
    const ctes = this.#with(statement.with, outer, inherited);
    if (statement.kind === "select") return { columns: this.#select(statement, outer, ctes), resultKind: "rows" };
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    const target = this.#relation(statement.table, false, scope, ctes);
    if (statement.kind === "insert") {
      const targets =
        statement.columns.length === 0
          ? Object.values(target?.table.columns ?? {}).filter((column) => !this.#generated(column))
          : statement.columns.map((column) => this.#findColumn(target?.table, column));
      for (const column of targets) {
        if (column !== undefined && this.#generated(column)) {
          this.#diagnostic("TSQ401", `Cannot INSERT into generated column ${column.name}`, statement.range);
        }
      }
      if (statement.source.kind === "values") {
        for (const row of statement.source.rows) {
          if (row.length !== targets.length)
            this.#diagnostic(
              "TSQ214",
              `INSERT has ${targets.length} target columns but ${row.length} values`,
              statement.source.range,
            );
          row.forEach((value, index) => {
            this.#expression(value, scope, ctes, this.#snapshotType(targets[index]));
          });
        }
      } else if (statement.source.kind === "select") {
        const selected = this.#statement(statement.source, outer, ctes);
        if (selected.columns.length !== targets.length)
          this.#diagnostic(
            "TSQ214",
            `INSERT has ${targets.length} target columns but SELECT returns ${selected.columns.length}`,
            statement.source.range,
          );
      }
      return statement.returning.length === 0
        ? { columns: [], resultKind: "command" }
        : { columns: this.#items(statement.returning, scope, ctes), resultKind: "rows" };
    }
    if (statement.kind === "update") {
      for (const assignment of statement.assignments) {
        const column = this.#findColumn(target?.table, assignment.column);
        if (column !== undefined && this.#generated(column)) {
          this.#diagnostic("TSQ401", `Cannot UPDATE generated column ${column.name}`, assignment.range);
        }
        this.#expression(assignment.value, scope, ctes, this.#snapshotType(column));
      }
      if (statement.from !== undefined) this.#relation(statement.from, false, scope, ctes);
      for (const join of statement.joins) this.#join(join, scope, ctes);
      if (statement.where !== undefined)
        this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
      return statement.returning.length === 0
        ? { columns: [], resultKind: "command" }
        : { columns: this.#items(statement.returning, scope, ctes), resultKind: "rows" };
    }
    if (statement.using.length > 0) {
      this.#unsupported("SQLite does not support DELETE USING", statement.using[0]!.range);
    }
    for (const reference of statement.using) this.#relation(reference, false, scope, ctes);
    if (statement.where !== undefined)
      this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    return statement.returning.length === 0
      ? { columns: [], resultKind: "command" }
      : { columns: this.#items(statement.returning, scope, ctes), resultKind: "rows" };
  }

  #with(
    withClause: WithClause | undefined,
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): Map<string, TableSnapshot> {
    const ctes = new Map(inherited);
    if (withClause === undefined) return ctes;
    if (withClause.recursive) this.#unsupported("Recursive CTE inference is not supported safely", withClause.range);
    for (const query of withClause.queries) {
      const key = name(query.name);
      if (ctes.has(key)) this.#diagnostic("TSQ211", `Duplicate CTE ${query.name.name}`, query.name.range);
      const result = this.#statement(query.statement, outer, ctes);
      if (query.statement.kind !== "select") {
        this.#unsupported("SQLite CTE bodies must be SELECT statements", query.statement.range);
      }
      if (result.resultKind === "command")
        this.#diagnostic("TSQ212", `CTE ${query.name.name} does not return rows`, query.range);
      if (query.columns.length > 0 && query.columns.length !== result.columns.length)
        this.#diagnostic("TSQ213", `CTE ${query.name.name} column count does not match its query`, query.range);
      const columns: Record<string, ColumnSnapshot> = {};
      result.columns.forEach((column, index) => {
        const columnName = query.columns[index] === undefined ? column.name : name(query.columns[index]!);
        columns[columnName] = {
          name: columnName,
          databaseType: column.databaseType ?? "unknown",
          tsType: column.tsType,
          nullable: column.nullable,
        };
      });
      ctes.set(key, { name: key, columns });
    }
    return ctes;
  }

  #select(
    statement: SelectStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedSqliteColumn[] {
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    if (statement.distinctOn.length > 0)
      this.#unsupported("SQLite does not support DISTINCT ON", statement.distinctOn[0]!.range);
    if (statement.from !== undefined) this.#relation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#join(join, scope, ctes);
    for (const clause of statement.locking)
      this.#unsupported("SQLite does not support SELECT locking clauses", clause.range);
    if (statement.where !== undefined)
      this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    for (const value of statement.groupBy) this.#expression(value, scope, ctes);
    if (statement.having !== undefined)
      this.#expression(statement.having, scope, ctes, this.#databaseType("boolean", false));
    for (const window of statement.windows) {
      for (const value of window.specification.partitionBy) this.#expression(value, scope, ctes);
      for (const item of window.specification.orderBy) this.#expression(item.expression, scope, ctes);
    }
    const columns = [...this.#items(statement.columns, scope, ctes)];
    const outputAliases = new Set(columns.map((column) => column.name));
    for (const compound of statement.compounds) {
      for (const output of this.#compoundOutputNames(compound.statement)) outputAliases.add(output);
    }
    for (const item of statement.orderBy) {
      const expression = item.expression;
      const outputAlias =
        expression.kind === "column" && expression.relation === undefined && outputAliases.has(name(expression.column));
      if (!outputAlias) this.#expression(expression, scope, ctes);
    }
    if (statement.limit !== undefined) this.#expression(statement.limit, scope, ctes, this.#databaseType("int", false));
    if (statement.offset !== undefined)
      this.#expression(statement.offset, scope, ctes, this.#databaseType("int", false));
    for (const compound of statement.compounds) {
      const right = this.#select(compound.statement, outer, ctes);
      if (right.length !== columns.length) {
        this.#diagnostic(
          "TSQ214",
          `Compound SELECT has ${columns.length} columns on the left and ${right.length} on the right`,
          compound.range,
        );
        continue;
      }
      for (let index = 0; index < columns.length; index += 1) {
        const left = columns[index]!;
        const candidate = right[index]!;
        const { databaseType: _databaseType, ...leftWithoutDatabaseType } = left;
        columns[index] = {
          ...leftWithoutDatabaseType,
          tsType: unionTypeLiterals([left.tsType, candidate.tsType]),
          nullable: left.nullable || candidate.nullable,
          ...(left.databaseType === candidate.databaseType && left.databaseType !== undefined
            ? { databaseType: left.databaseType }
            : {}),
        };
      }
    }
    return columns;
  }

  #compoundOutputNames(statement: SelectStatement): ReadonlySet<string> {
    const outputs = new Set<string>();
    for (const item of statement.columns) {
      const output = item.alias === undefined ? this.#outputName(item.expression) : name(item.alias);
      if (output !== undefined) outputs.add(output);
    }
    for (const compound of statement.compounds) {
      for (const output of this.#compoundOutputNames(compound.statement)) outputs.add(output);
    }
    return outputs;
  }

  #join(join: SelectStatement["joins"][number], scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const previous = [...scope.relations];
    if (join.kind === "right" || join.kind === "full") for (const relation of previous) relation.nullable = true;
    const relation = this.#relation(join.table, join.kind === "left" || join.kind === "full", scope, ctes);
    if (join.on !== undefined) this.#expression(join.on, scope, ctes, this.#databaseType("boolean", false));
    if (join.using === undefined || relation === undefined) return;
    for (const identifier of join.using) {
      const columnName = name(identifier);
      const leftMatches = previous.filter((candidate) => this.#column(candidate.table, columnName) !== undefined);
      const right = this.#column(relation.table, columnName);
      if (leftMatches.length !== 1 || right === undefined) {
        this.#diagnostic(
          "TSQ215",
          `JOIN USING column ${identifier.name} must exist once on both sides`,
          identifier.range,
        );
        continue;
      }
      const left = this.#columnType(leftMatches[0]!, this.#column(leftMatches[0]!.table, columnName)!);
      const rightType = this.#columnType(relation, right);
      scope.usingColumns.set(columnName, {
        tsType: unionTypeLiterals([left.tsType, rightType.tsType]),
        nullable:
          join.kind === "left"
            ? left.nullable
            : join.kind === "right"
              ? rightType.nullable
              : left.nullable || rightType.nullable,
        ...(left.databaseType === rightType.databaseType && left.databaseType !== undefined
          ? { databaseType: left.databaseType }
          : {}),
      });
    }
  }

  #relation(
    reference: TableReference,
    nullable: boolean,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): Relation | undefined {
    let table: TableSnapshot | undefined;
    let alias: string;
    if (reference.kind === "subquery") {
      if (reference.lateral) this.#unsupported("SQLite does not support LATERAL subqueries", reference.range);
      const result = this.#statement(reference.query, reference.lateral ? scope : scope.outer, ctes);
      const columns: Record<string, ColumnSnapshot> = {};
      for (const column of result.columns)
        columns[column.name] = {
          name: column.name,
          databaseType: column.databaseType ?? "unknown",
          tsType: column.tsType,
          nullable: column.nullable,
        };
      table = { name: name(reference.alias), columns };
      alias = name(reference.alias);
    } else {
      const requested = name(reference.name);
      const requestedSchema = reference.schema === undefined ? undefined : name(reference.schema);
      if (requestedSchema === undefined) table = ctes.get(requested);
      if (table === undefined) {
        const matches = this.#index.tables(requested, requestedSchema);
        if (matches.length === 0) {
          this.#diagnostic("TSQ100", `Unknown table ${reference.name.name}`, reference.name.range);
          return undefined;
        }
        if (requestedSchema === undefined && matches.length > 1) {
          this.#diagnostic(
            "TSQ107",
            `Ambiguous table ${reference.name.name}`,
            reference.name.range,
            "Qualify the table with a database name.",
          );
          return undefined;
        }
        table = matches[0]!.table;
      }
      alias = reference.alias === undefined ? requested : name(reference.alias);
    }
    if (scope.relations.some((candidate) => candidate.alias === alias)) {
      this.#diagnostic("TSQ108", `Duplicate relation alias ${alias}`, reference.range);
      return undefined;
    }
    const relation = { alias, table, nullable };
    scope.relations.push(relation);
    return relation;
  }

  #items(
    items: readonly SelectItem[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedSqliteColumn[] {
    const columns: ResolvedSqliteColumn[] = [];
    const names = new Set<string>();
    const add = (column: ResolvedSqliteColumn): void => {
      if (names.has(column.name)) this.#diagnostic("TSQ105", `Duplicate output property ${column.name}`, column.range);
      else {
        names.add(column.name);
        columns.push(column);
      }
    };
    for (const item of items) {
      if (item.expression.kind === "star") {
        const star = item.expression;
        const relations =
          star.relation === undefined
            ? scope.relations
            : scope.relations.filter((relation) => relation.alias === name(star.relation!));
        if (relations.length === 0) {
          this.#diagnostic(
            "TSQ103",
            star.relation === undefined
              ? "SELECT * requires a FROM relation"
              : `Unknown relation alias ${star.relation.name}`,
            item.range,
          );
          continue;
        }
        if (star.relation === undefined)
          for (const [columnName, type] of scope.usingColumns) add({ name: columnName, ...type, range: item.range });
        for (const relation of relations)
          for (const column of Object.values(relation.table.columns)) {
            if (star.relation === undefined && scope.usingColumns.has(column.name.toLowerCase())) continue;
            add({ name: column.name, ...this.#columnType(relation, column), range: item.range });
          }
        continue;
      }
      const type = this.#expression(item.expression, scope, ctes);
      const output = item.alias === undefined ? this.#outputName(item.expression) : name(item.alias);
      if (output === undefined) {
        if (this.#strict)
          this.#diagnostic("TSQ104", "Expressions in SELECT require an explicit alias", item.range, "Add AS <name>.");
        continue;
      }
      add({ name: output, ...type, range: item.range });
    }
    return columns;
  }

  #expression(
    expression: Expression,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
    expected?: ResolvedType,
  ): ResolvedType {
    if (expression.kind === "column") {
      if (expression.relation === undefined && expression.column.name === "DEFAULT")
        return { tsType: "unknown", nullable: true };
      return this.#resolveColumn(expression.relation, expression.column, scope);
    }
    if (expression.kind === "literal") {
      if (expression.value === null) return { tsType: "unknown", nullable: true };
      if (typeof expression.value === "boolean")
        return { tsType: this.#policy.integer, nullable: false, databaseType: "integer" };
      if (typeof expression.value === "number")
        return {
          tsType: Number.isInteger(expression.value) ? this.#policy.integer : "number",
          nullable: false,
          databaseType: Number.isInteger(expression.value) ? "integer" : "real",
        };
      return { tsType: "string", nullable: false, databaseType: "varchar" };
    }
    if (expression.kind === "parameter") return this.#recordParameter(expression.index, expected);
    if (expression.kind === "star") return { tsType: "unknown", nullable: false };
    if (expression.kind === "array") {
      this.#unsupported("SQLite does not support ARRAY constructors", expression.range);
      return { tsType: "unknown", nullable: true };
    }
    if (expression.kind === "row") {
      const values = expression.elements.map((value) => this.#expression(value, scope, ctes));
      return {
        tsType: `readonly [${values.map((value) => `${value.tsType}${value.nullable ? " | null" : ""}`).join(", ")}]`,
        nullable: false,
      };
    }
    if (expression.kind === "cast") {
      const source = this.#expression(
        expression.expression,
        scope,
        ctes,
        this.#databaseType(expression.databaseType.name, true),
      );
      if (!isKnownSqliteType(expression.databaseType.name))
        this.#diagnostic(
          "TSQ106",
          `Invalid or unknown SQLite cast type ${expression.databaseType.name}`,
          expression.databaseType.range,
        );
      return {
        tsType: mapSqliteCastType(expression.databaseType.name, this.#policy),
        nullable: source.nullable,
        databaseType: normalized(expression.databaseType.name),
      };
    }
    if (expression.kind === "unary") {
      const operand = this.#expression(expression.expression, scope, ctes);
      return expression.operator === "NOT"
        ? { tsType: this.#policy.integer, nullable: operand.nullable, databaseType: "integer" }
        : operand;
    }
    if (expression.kind === "binary") return this.#binary(expression, scope, ctes);
    if (expression.kind === "call") return this.#call(expression, scope, ctes);
    if (expression.kind === "case") {
      if (expression.operand !== undefined) this.#expression(expression.operand, scope, ctes);
      for (const branch of expression.branches) this.#expression(branch.when, scope, ctes);
      const values = expression.branches.map((branch) => this.#expression(branch.then, scope, ctes));
      if (expression.elseExpression !== undefined)
        values.push(this.#expression(expression.elseExpression, scope, ctes));
      return {
        tsType: unionTypeLiterals(values.map((value) => value.tsType)),
        nullable: expression.elseExpression === undefined || values.some((value) => value.nullable),
      };
    }
    if (expression.kind === "subquery") {
      const result = this.#statement(expression.query, scope, ctes);
      if (result.columns.length !== 1) {
        this.#diagnostic(
          "TSQ216",
          `Scalar subquery returns ${result.columns.length} columns instead of one`,
          expression.range,
        );
        return { tsType: "unknown", nullable: true };
      }
      const column = result.columns[0]!;
      return {
        tsType: column.tsType,
        nullable: true,
        ...(column.databaseType === undefined ? {} : { databaseType: column.databaseType }),
      };
    }
    if (expression.kind === "exists") {
      this.#statement(expression.query, scope, ctes);
      return { tsType: this.#policy.integer, nullable: false, databaseType: "integer" };
    }
    if (expression.kind === "in") {
      const subject = this.#expression(expression.expression, scope, ctes);
      let nullable = subject.nullable;
      if (Array.isArray(expression.values))
        nullable ||= expression.values
          .map((value) => this.#expression(value, scope, ctes, subject))
          .some((value) => value.nullable);
      else {
        const result = this.#statement(expression.values as SelectStatement, scope, ctes);
        if (result.columns.length !== 1)
          this.#diagnostic(
            "TSQ217",
            `IN subquery returns ${result.columns.length} columns instead of one`,
            expression.range,
          );
        nullable ||= result.columns[0]?.nullable ?? true;
      }
      return { tsType: this.#policy.integer, nullable, databaseType: "integer" };
    }
    const subject = this.#expression(expression.expression, scope, ctes);
    const values = [
      subject,
      this.#expression(expression.lower, scope, ctes, subject),
      this.#expression(expression.upper, scope, ctes, subject),
    ];
    return {
      tsType: this.#policy.integer,
      nullable: values.some((value) => value.nullable),
      databaseType: "integer",
    };
  }

  #binary(
    expression: Extract<Expression, { readonly kind: "binary" }>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
    if (
      ["ILIKE", "SIMILAR TO", "~", "~*", "!~", "!~*", "@>", "<@", "?", "?|", "?&", "&&"].includes(expression.operator)
    ) {
      this.#unsupported(`SQLite does not support operator ${expression.operator}`, expression.range);
    }
    let left: ResolvedType;
    let right: ResolvedType;
    if (expression.left.kind === "parameter" && expression.right.kind !== "parameter") {
      right = this.#expression(expression.right, scope, ctes);
      left = this.#expression(expression.left, scope, ctes, right);
    } else {
      left = this.#expression(expression.left, scope, ctes);
      right = this.#expression(expression.right, scope, ctes, expression.right.kind === "parameter" ? left : undefined);
    }
    if (comparisonOperators.has(expression.operator))
      return {
        tsType: this.#policy.integer,
        nullable: expression.operator.startsWith("IS") ? false : left.nullable || right.nullable,
        databaseType: "integer",
      };
    if (expression.operator === "||") {
      return { tsType: "string", nullable: left.nullable || right.nullable, databaseType: "text" };
    }
    if (expression.operator === "->") return { tsType: "string", nullable: true, databaseType: "text" };
    if (expression.operator === "->>")
      return {
        tsType: sqliteFlexibleType(this.#policy),
        nullable: true,
      };
    const leftType = left.databaseType === undefined ? undefined : normalized(left.databaseType);
    const rightType = right.databaseType === undefined ? undefined : normalized(right.databaseType);
    if (
      leftType !== undefined &&
      rightType !== undefined &&
      numericTypes.has(leftType) &&
      numericTypes.has(rightType)
    ) {
      return {
        tsType: unionTypeLiterals([this.#policy.integer, "number"]),
        nullable: left.nullable || right.nullable,
        databaseType: "numeric",
      };
    }
    if (left.tsType === "unknown" || right.tsType === "unknown")
      return { tsType: "unknown", nullable: left.nullable || right.nullable };
    this.#diagnostic("TSQ203", `Cannot safely infer SQLite operator ${expression.operator}`, expression.range);
    return { tsType: "unknown", nullable: true };
  }

  #call(expression: CallExpression, scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): ResolvedType {
    const values = expression.arguments.map((argument) => this.#expression(argument, scope, ctes));
    if (expression.filter !== undefined)
      this.#expression(expression.filter, scope, ctes, this.#databaseType("integer", false));
    if (expression.over !== undefined && "partitionBy" in expression.over) {
      for (const value of expression.over.partitionBy) this.#expression(value, scope, ctes);
      for (const item of expression.over.orderBy) this.#expression(item.expression, scope, ctes);
    }
    const functionName = expression.name.name.toUpperCase();
    if (functionName === "COUNT") return { tsType: this.#policy.integer, nullable: false, databaseType: "integer" };
    if (functionName === "SUM")
      return {
        tsType: unionTypeLiterals([this.#policy.integer, "number"]),
        nullable: true,
        databaseType: "numeric",
      };
    if (functionName === "AVG") return { tsType: "number", nullable: true, databaseType: "real" };
    if (["MIN", "MAX"].includes(functionName)) return { ...(values[0] ?? { tsType: "unknown" }), nullable: true };
    if (functionName === "COALESCE")
      return {
        tsType: unionTypeLiterals(values.map((value) => value.tsType)),
        nullable: values.every((value) => value.nullable),
      };
    if (functionName === "IFNULL" || functionName === "NULLIF") {
      const firstArgument = expression.arguments[0];
      const secondArgument = expression.arguments[1];
      if (firstArgument?.kind === "parameter" && values[1] !== undefined) {
        this.#expression(firstArgument, scope, ctes, values[1]);
      }
      if (secondArgument?.kind === "parameter" && values[0] !== undefined) {
        this.#expression(secondArgument, scope, ctes, values[0]);
      }
      return {
        ...(values[0] ?? { tsType: "unknown" }),
        nullable: functionName === "NULLIF" || values.every((value) => value.nullable),
      };
    }
    if (functionName === "GROUP_CONCAT") return { tsType: "string", nullable: true, databaseType: "text" };
    if (["JSON", "JSON_ARRAY", "JSON_OBJECT", "JSON_GROUP_ARRAY", "JSON_GROUP_OBJECT"].includes(functionName))
      return { tsType: "string", nullable: true, databaseType: "text" };
    if (functionName === "RANDOM") return { tsType: this.#policy.integer, nullable: false, databaseType: "integer" };
    if (functionName === "LENGTH") return { tsType: this.#policy.integer, nullable: true, databaseType: "integer" };
    const candidates = this.#index.functions(
      name(expression.name),
      values.length,
      expression.schema === undefined ? undefined : name(expression.schema),
    );
    const selected = candidates.length === 1 ? candidates[0] : undefined;
    if (selected !== undefined) {
      expression.arguments.forEach((argument, index) => {
        if (argument.kind === "parameter")
          this.#expression(argument, scope, ctes, this.#databaseType(selected.argumentTypes[index]!, true));
      });
      return this.#function(selected);
    }
    this.#diagnostic(
      candidates.length > 1 ? "TSQ204" : "TSQ202",
      candidates.length > 1 ? `Ambiguous function ${expression.name.name}` : `Unknown function ${expression.name.name}`,
      expression.range,
      undefined,
      candidates.length > 1 ? "error" : "warning",
    );
    return { tsType: "unknown", nullable: true };
  }

  #resolveColumn(relationIdentifier: Identifier | undefined, columnIdentifier: Identifier, scope: Scope): ResolvedType {
    const columnName = name(columnIdentifier);
    if (relationIdentifier === undefined) {
      const using = scope.usingColumns.get(columnName);
      if (using !== undefined) return using;
    }
    const relations =
      relationIdentifier === undefined
        ? scope.relations
        : scope.relations.filter((relation) => relation.alias === name(relationIdentifier));
    const matches = relations.flatMap((relation): readonly [Relation, ColumnSnapshot][] => {
      const column = this.#column(relation.table, columnName);
      return column === undefined ? [] : [[relation, column]];
    });
    if (matches.length > 1) {
      this.#diagnostic("TSQ102", `Ambiguous column ${columnIdentifier.name}`, columnIdentifier.range);
      return { tsType: "unknown", nullable: true };
    }
    if (matches.length === 0) {
      if (scope.outer !== undefined) return this.#resolveColumn(relationIdentifier, columnIdentifier, scope.outer);
      this.#diagnostic(
        relationIdentifier === undefined ? "TSQ101" : "TSQ103",
        relationIdentifier === undefined
          ? `Unknown column ${columnIdentifier.name}`
          : `Unknown relation or column ${relationIdentifier.name}.${columnIdentifier.name}`,
        columnIdentifier.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    return this.#columnType(matches[0]![0], matches[0]![1]);
  }

  #column(table: TableSnapshot, columnName: string): ColumnSnapshot | undefined {
    return this.#index.column(table, columnName);
  }

  #findColumn(table: TableSnapshot | undefined, identifier: Identifier): ColumnSnapshot | undefined {
    const column = table === undefined ? undefined : this.#column(table, name(identifier));
    if (column === undefined) this.#diagnostic("TSQ101", `Unknown column ${identifier.name}`, identifier.range);
    return column;
  }

  #columnType(relation: Relation, column: ColumnSnapshot): ResolvedType {
    return { tsType: column.tsType, nullable: column.nullable || relation.nullable, databaseType: column.databaseType };
  }

  #outputName(expression: Expression): string | undefined {
    if (expression.kind === "column") return name(expression.column);
    if (expression.kind === "cast") return this.#outputName(expression.expression);
    if (expression.kind === "call") return name(expression.name);
    if (expression.kind === "case") return "case";
    return undefined;
  }

  #function(value: FunctionSnapshot): ResolvedType {
    return {
      tsType: value.returnType,
      nullable: value.nullable,
      ...(value.databaseReturnType === undefined ? {} : { databaseType: value.databaseReturnType }),
    };
  }

  #snapshotType(column: ColumnSnapshot | undefined): ResolvedType | undefined {
    if (column === undefined) return undefined;
    return { tsType: column.tsType, nullable: column.nullable, databaseType: column.databaseType };
  }

  #generated(column: ColumnSnapshot): boolean {
    return "generated" in column && (column.generated === "virtual" || column.generated === "stored");
  }

  #databaseType(databaseType: string, nullable: boolean): ResolvedType {
    return {
      tsType: mapSqliteCastType(databaseType, this.#policy),
      nullable,
      databaseType: normalized(databaseType),
    };
  }

  #recordParameter(index: number, expected: ResolvedType | undefined): ResolvedType {
    return this.#parameters.record(index, expected);
  }

  #unsupported(message: string, range: SourceRange): void {
    this.#diagnostic("TSQ401", message, range);
  }

  #diagnostic(
    code: string,
    message: string,
    range: SourceRange,
    suggestion?: string,
    severity: SqlDiagnostic["severity"] = "error",
  ): void {
    this.#diagnostics.push({ code, message, range, severity, ...(suggestion === undefined ? {} : { suggestion }) });
  }
}

export function resolveSqliteStatement(
  statement: Statement,
  schema: SchemaSnapshot,
  options: ResolveSqliteOptions = {},
): ResolvedSqliteQuery {
  return new Resolver(schema, options).resolve(statement);
}
