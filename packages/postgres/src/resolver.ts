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
  UpdateStatement,
  WithClause,
} from "@typed-sql/ast";
import {
  closestName,
  ParameterCollector,
  type ResolvedParameter,
  ResolverSchemaIndex,
  unionTypeLiterals,
} from "@typed-sql/core";
import type { ColumnSnapshot, FunctionSnapshot, SchemaSnapshot, TableSnapshot } from "@typed-sql/schema";
import {
  defaultPostgresTypePolicy,
  isKnownPostgresType,
  mapPostgresType,
  type PostgresTypePolicy,
} from "./type-policy.js";

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

interface ResolvedType {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

export interface ResolvedColumn extends ResolvedType {
  readonly name: string;
  readonly range: SourceRange;
}

export interface ResolvedQuery {
  readonly columns: readonly ResolvedColumn[];
  readonly parameters: readonly ResolvedParameter[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly resultKind: "rows" | "command";
}

export interface ResolveOptions {
  readonly typePolicy?: PostgresTypePolicy;
  readonly strictExpressions?: boolean;
}

const booleanOperators = new Set([
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
  "ILIKE",
  "NOT ILIKE",
  "SIMILAR TO",
  "NOT SIMILAR",
  "~",
  "~*",
  "!~",
  "!~*",
  "AND",
  "OR",
  "@>",
  "<@",
  "?",
  "?|",
  "?&",
  "&&",
]);

const numericTypes = new Set([
  "smallint",
  "int2",
  "integer",
  "int",
  "int4",
  "bigint",
  "int8",
  "numeric",
  "decimal",
  "real",
  "float4",
  "double precision",
  "float8",
]);

function sqlName(identifier: Identifier): string {
  return identifier.quoted ? identifier.name : identifier.name.toLowerCase();
}

function normalizeDatabaseType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\(\d+(?:,\s*\d+)?\)/gu, "")
    .replace(/\s+/gu, " ");
}

function suggestion(name: string, candidates: readonly string[]): string | undefined {
  const candidate = closestName(name, candidates);
  if (candidate === undefined) return undefined;
  return `Did you mean ${candidate}?`;
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: PostgresTypePolicy;
  readonly #strictExpressions: boolean;
  readonly #diagnostics: SqlDiagnostic[] = [];
  readonly #parameters = new ParameterCollector();
  readonly #index: ResolverSchemaIndex;

  constructor(schema: SchemaSnapshot, options: ResolveOptions) {
    this.#schema = schema;
    this.#index = ResolverSchemaIndex.for(schema);
    this.#policy = options.typePolicy ?? defaultPostgresTypePolicy;
    this.#strictExpressions = options.strictExpressions ?? true;
  }

  resolve(statement: Statement): ResolvedQuery {
    if (this.#schema.dialect !== "postgres") {
      this.#diagnostic("TSQ007", `PostgreSQL resolver cannot analyze ${this.#schema.dialect}`, statement.range);
    }
    const result = this.#resolveStatement(statement, undefined, new Map());
    return {
      ...result,
      parameters: this.#parameters.values(),
      diagnostics: this.#diagnostics,
    };
  }

  #resolveStatement(
    statement: Statement,
    outer: Scope | undefined,
    inheritedCtes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const ctes = this.#resolveWith(statement.with, outer, inheritedCtes);
    switch (statement.kind) {
      case "select":
        return { columns: this.#resolveSelect(statement, outer, ctes), resultKind: "rows" };
      case "insert":
        return this.#resolveInsert(statement, outer, ctes);
      case "update":
        return this.#resolveUpdate(statement, outer, ctes);
      case "delete":
        return this.#resolveDelete(statement, outer, ctes);
    }
  }

  #resolveWith(
    withClause: WithClause | undefined,
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): Map<string, TableSnapshot> {
    const ctes = new Map(inherited);
    if (withClause === undefined) return ctes;
    if (withClause.recursive) {
      this.#diagnostic(
        "TSQ210",
        "Recursive CTE inference is not supported safely",
        withClause.range,
        "Use a non-recursive CTE or annotate the query explicitly.",
      );
    }
    for (const query of withClause.queries) {
      const key = sqlName(query.name);
      if (ctes.has(key)) this.#diagnostic("TSQ211", `Duplicate CTE ${query.name.name}`, query.name.range);
      if (withClause.recursive) {
        const placeholderColumns: Record<string, ColumnSnapshot> = {};
        for (const column of query.columns) {
          placeholderColumns[sqlName(column)] = {
            name: sqlName(column),
            databaseType: "unknown",
            tsType: "unknown",
            nullable: true,
          };
        }
        ctes.set(key, { name: key, columns: placeholderColumns });
      }
      const resolved = this.#resolveStatement(query.statement, outer, ctes);
      if (resolved.resultKind === "command") {
        this.#diagnostic(
          "TSQ212",
          `CTE ${query.name.name} does not return rows`,
          query.range,
          "Add RETURNING to the data-changing CTE.",
        );
      }
      if (query.columns.length > 0 && query.columns.length !== resolved.columns.length) {
        this.#diagnostic(
          "TSQ213",
          `CTE ${query.name.name} declares ${query.columns.length} columns but returns ${resolved.columns.length}`,
          query.range,
        );
      }
      const columns: Record<string, ColumnSnapshot> = {};
      resolved.columns.forEach((column, index) => {
        const declared = query.columns[index];
        const name = declared === undefined ? column.name : sqlName(declared);
        columns[name] = {
          name,
          databaseType: column.databaseType ?? "unknown",
          tsType: column.tsType,
          nullable: column.nullable,
        };
      });
      ctes.set(key, { name: key, columns });
    }
    return ctes;
  }

  #resolveSelect(
    statement: SelectStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedColumn[] {
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    if (statement.from !== undefined) this.#addRelation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#addJoin(join, scope, ctes);
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    for (const expression of statement.groupBy) this.#resolveExpression(expression, scope, ctes);
    if (statement.having !== undefined)
      this.#resolveExpression(statement.having, scope, ctes, this.#databaseType("boolean", false));
    for (const expression of statement.distinctOn) this.#resolveExpression(expression, scope, ctes);
    for (const window of statement.windows) {
      for (const expression of window.specification.partitionBy) this.#resolveExpression(expression, scope, ctes);
      for (const order of window.specification.orderBy) this.#resolveExpression(order.expression, scope, ctes);
    }
    for (const order of statement.orderBy) this.#resolveExpression(order.expression, scope, ctes);
    if (statement.limit !== undefined)
      this.#resolveExpression(statement.limit, scope, ctes, this.#databaseType("integer", false));
    if (statement.offset !== undefined)
      this.#resolveExpression(statement.offset, scope, ctes, this.#databaseType("integer", false));
    return this.#resolveItems(statement.columns, scope, ctes);
  }

  #resolveInsert(
    statement: Extract<Statement, { readonly kind: "insert" }>,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    const targetColumns =
      statement.columns.length === 0
        ? Object.values(target?.table.columns ?? {})
        : statement.columns.map((column) => this.#findColumn(target?.table, column));
    if (statement.source.kind === "values") {
      for (const row of statement.source.rows) {
        if (row.length !== targetColumns.length) {
          this.#diagnostic(
            "TSQ214",
            `INSERT has ${targetColumns.length} target columns but ${row.length} values`,
            statement.source.range,
          );
        }
        row.forEach((value, index) => {
          this.#resolveExpression(value, scope, ctes, this.#snapshotType(targetColumns[index]));
        });
      }
    } else if (statement.source.kind === "select") {
      const source = this.#resolveStatement(statement.source, outer, ctes);
      if (source.columns.length !== targetColumns.length) {
        this.#diagnostic(
          "TSQ214",
          `INSERT has ${targetColumns.length} target columns but SELECT returns ${source.columns.length}`,
          statement.source.range,
        );
      }
    }
    const columns = this.#resolveItems(statement.returning, scope, ctes);
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveUpdate(
    statement: UpdateStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    for (const assignment of statement.assignments) {
      const column = this.#findColumn(target?.table, assignment.column);
      this.#resolveExpression(assignment.value, scope, ctes, this.#snapshotType(column));
    }
    if (statement.from !== undefined) this.#addRelation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#addJoin(join, scope, ctes);
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    const columns = this.#resolveItems(statement.returning, scope, ctes);
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveDelete(
    statement: Extract<Statement, { readonly kind: "delete" }>,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    this.#addRelation(statement.table, false, scope, ctes);
    for (const reference of statement.using) this.#addRelation(reference, false, scope, ctes);
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    const columns = this.#resolveItems(statement.returning, scope, ctes);
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #addJoin(join: SelectStatement["joins"][number], scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const previous = [...scope.relations];
    if (join.kind === "right" || join.kind === "full") for (const relation of previous) relation.nullable = true;
    const relation = this.#addRelation(join.table, join.kind === "left" || join.kind === "full", scope, ctes);
    if (join.on !== undefined) this.#resolveExpression(join.on, scope, ctes, this.#databaseType("boolean", false));
    if (join.using !== undefined && relation !== undefined) {
      for (const identifier of join.using) {
        const name = sqlName(identifier);
        const leftMatches = previous.filter(
          (candidate) => this.#column(candidate, name, identifier.quoted) !== undefined,
        );
        const right = this.#column(relation, name, identifier.quoted);
        if (leftMatches.length !== 1 || right === undefined) {
          this.#diagnostic(
            "TSQ215",
            `JOIN USING column ${identifier.name} must exist once on both sides`,
            identifier.range,
          );
          continue;
        }
        const left = this.#columnType(leftMatches[0]!, this.#column(leftMatches[0]!, name, identifier.quoted)!);
        const rightType = this.#columnType(relation, right);
        scope.usingColumns.set(name, {
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
  }

  #addRelation(
    reference: TableReference,
    nullable: boolean,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): Relation | undefined {
    let table: TableSnapshot | undefined;
    let alias: string;
    if (reference.kind === "subquery") {
      const outer = reference.lateral ? scope : scope.outer;
      const resolved = this.#resolveStatement(reference.query, outer, ctes);
      const columns: Record<string, ColumnSnapshot> = {};
      for (const column of resolved.columns) {
        columns[column.name] = {
          name: column.name,
          databaseType: column.databaseType ?? "unknown",
          tsType: column.tsType,
          nullable: column.nullable,
        };
      }
      table = { name: sqlName(reference.alias), columns };
      alias = sqlName(reference.alias);
    } else {
      const requested = sqlName(reference.name);
      const requestedSchema = reference.schema === undefined ? undefined : sqlName(reference.schema);
      if (requestedSchema === undefined) table = ctes.get(requested);
      if (table === undefined) {
        const entries = this.#index.tables(
          requested,
          requestedSchema,
          reference.name.quoted || reference.schema?.quoted === true,
        );
        if (entries.length === 0) {
          this.#diagnostic(
            "TSQ100",
            `Unknown table ${reference.name.name}`,
            reference.name.range,
            suggestion(requested, [...ctes.keys(), ...Object.keys(this.#schema.tables)]),
          );
          return undefined;
        }
        if (requestedSchema === undefined && entries.length > 1) {
          this.#diagnostic(
            "TSQ107",
            `Ambiguous table ${reference.name.name}`,
            reference.name.range,
            "Qualify the table with a schema name.",
          );
          return undefined;
        }
        table = entries[0]!.table;
      }
      alias = reference.alias === undefined ? requested : sqlName(reference.alias);
    }
    if (scope.relations.some((candidate) => candidate.alias === alias)) {
      this.#diagnostic("TSQ108", `Duplicate relation alias ${alias}`, reference.range, "Use a unique table alias.");
      return undefined;
    }
    const relation: Relation = { alias, table, nullable };
    scope.relations.push(relation);
    return relation;
  }

  #resolveItems(
    items: readonly SelectItem[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedColumn[] {
    const columns: ResolvedColumn[] = [];
    const names = new Set<string>();
    const add = (column: ResolvedColumn): void => {
      if (names.has(column.name)) {
        this.#diagnostic(
          "TSQ105",
          `Duplicate output property ${column.name}`,
          column.range,
          "Give one expression a unique alias.",
        );
        return;
      }
      names.add(column.name);
      columns.push(column);
    };
    for (const item of items) {
      if (item.expression.kind === "star") {
        const star = item.expression;
        const relations =
          star.relation === undefined
            ? scope.relations
            : scope.relations.filter((relation) => relation.alias === sqlName(star.relation!));
        if (relations.length === 0) {
          this.#diagnostic(
            "TSQ103",
            star.relation === undefined
              ? "SELECT * requires a FROM relation"
              : `Unknown relation alias ${star.relation.name}`,
            star.range,
          );
          continue;
        }
        if (star.relation === undefined) {
          for (const [name, type] of scope.usingColumns) add({ name, ...type, range: item.range });
        }
        for (const relation of relations) {
          for (const column of Object.values(relation.table.columns)) {
            if (
              star.relation === undefined &&
              (scope.usingColumns.has(column.name) || scope.usingColumns.has(column.name.toLowerCase()))
            )
              continue;
            add({ name: column.name, ...this.#columnType(relation, column), range: item.range });
          }
        }
        continue;
      }
      const type = this.#resolveExpression(item.expression, scope, ctes);
      const inferredName = this.#outputName(item.expression);
      const name = item.alias === undefined ? inferredName : sqlName(item.alias);
      if (name === undefined) {
        if (this.#strictExpressions)
          this.#diagnostic(
            "TSQ104",
            "Expressions in SELECT or RETURNING require an explicit alias",
            item.range,
            "Add AS <name>.",
          );
        continue;
      }
      add({ name, ...type, range: item.range });
    }
    return columns;
  }

  #outputName(expression: Expression): string | undefined {
    if (expression.kind === "column") return sqlName(expression.column);
    if (expression.kind === "cast") return this.#outputName(expression.expression);
    if (expression.kind === "call") return sqlName(expression.name);
    if (expression.kind === "case") return "case";
    return undefined;
  }

  #resolveExpression(
    expression: Expression,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
    expected?: ResolvedType,
  ): ResolvedType {
    switch (expression.kind) {
      case "column": {
        if (expression.relation === undefined && expression.column.name === "DEFAULT")
          return { tsType: "unknown", nullable: true };
        return this.#resolveColumn(expression.relation, expression.column, scope);
      }
      case "literal": {
        if (expression.value === null) return { tsType: "unknown", nullable: true };
        if (typeof expression.value === "boolean")
          return { tsType: "boolean", nullable: false, databaseType: "boolean" };
        if (typeof expression.value === "number")
          return {
            tsType: "number",
            nullable: false,
            databaseType: Number.isInteger(expression.value) ? "integer" : "numeric",
          };
        return { tsType: "string", nullable: false, databaseType: "text" };
      }
      case "parameter":
        return this.#recordParameter(expression.index, expected);
      case "star":
        return { tsType: "unknown", nullable: false };
      case "array": {
        const elements = expression.elements.map((element) => this.#resolveExpression(element, scope, ctes));
        const elementType = unionTypeLiterals(elements.map((element) => element.tsType));
        const databaseTypes = [
          ...new Set(
            elements.map((element) => element.databaseType).filter((value): value is string => value !== undefined),
          ),
        ];
        return {
          tsType: `readonly (${elementType})[]`,
          nullable: false,
          ...(databaseTypes.length === 1 ? { databaseType: `${databaseTypes[0]}[]` } : {}),
        };
      }
      case "row": {
        const elements = expression.elements.map((element) => this.#resolveExpression(element, scope, ctes));
        return {
          tsType: `readonly [${elements.map((element) => element.tsType + (element.nullable ? " | null" : "")).join(", ")}]`,
          nullable: false,
        };
      }
      case "cast": {
        const castType = this.#databaseType(expression.databaseType.name, true);
        const source = this.#resolveExpression(expression.expression, scope, ctes, castType);
        if (!isKnownPostgresType(expression.databaseType.name, this.#schema)) {
          this.#diagnostic(
            "TSQ106",
            `Invalid or unknown PostgreSQL cast type ${expression.databaseType.name}`,
            expression.databaseType.range,
          );
        }
        return {
          tsType: mapPostgresType(expression.databaseType.name, this.#policy, this.#schema),
          nullable: source.nullable,
          databaseType: normalizeDatabaseType(expression.databaseType.name),
        };
      }
      case "unary": {
        const operand = this.#resolveExpression(expression.expression, scope, ctes);
        return expression.operator === "NOT"
          ? { tsType: "boolean", nullable: operand.nullable, databaseType: "boolean" }
          : operand;
      }
      case "binary":
        return this.#resolveBinary(expression, scope, ctes);
      case "call":
        return this.#resolveCall(expression, scope, ctes);
      case "case": {
        if (expression.operand !== undefined) this.#resolveExpression(expression.operand, scope, ctes);
        for (const branch of expression.branches) this.#resolveExpression(branch.when, scope, ctes);
        const results = expression.branches.map((branch) => this.#resolveExpression(branch.then, scope, ctes));
        if (expression.elseExpression !== undefined)
          results.push(this.#resolveExpression(expression.elseExpression, scope, ctes));
        const databaseTypes = [
          ...new Set(
            results.map((result) => result.databaseType).filter((value): value is string => value !== undefined),
          ),
        ];
        return {
          tsType: unionTypeLiterals(results.map((result) => result.tsType)),
          nullable: expression.elseExpression === undefined || results.some((result) => result.nullable),
          ...(databaseTypes.length === 1 ? { databaseType: databaseTypes[0] } : {}),
        };
      }
      case "subquery": {
        const resolved = this.#resolveStatement(expression.query, scope, ctes);
        if (resolved.columns.length !== 1) {
          this.#diagnostic(
            "TSQ216",
            `Scalar subquery returns ${resolved.columns.length} columns instead of one`,
            expression.range,
          );
          return { tsType: "unknown", nullable: true };
        }
        const column = resolved.columns[0]!;
        return {
          tsType: column.tsType,
          nullable: true,
          ...(column.databaseType === undefined ? {} : { databaseType: column.databaseType }),
        };
      }
      case "exists": {
        this.#resolveStatement(expression.query, scope, ctes);
        return { tsType: "boolean", nullable: false, databaseType: "boolean" };
      }
      case "in": {
        const subject = this.#resolveExpression(expression.expression, scope, ctes);
        let nullable = subject.nullable;
        if (Array.isArray(expression.values)) {
          const values = expression.values.map((value) => this.#resolveExpression(value, scope, ctes, subject));
          nullable ||= values.some((value) => value.nullable);
        } else {
          const resolved = this.#resolveStatement(expression.values as SelectStatement, scope, ctes);
          if (resolved.columns.length !== 1)
            this.#diagnostic(
              "TSQ217",
              `IN subquery returns ${resolved.columns.length} columns instead of one`,
              expression.range,
            );
          nullable ||= resolved.columns[0]?.nullable ?? true;
        }
        return { tsType: "boolean", nullable, databaseType: "boolean" };
      }
      case "between": {
        const subject = this.#resolveExpression(expression.expression, scope, ctes);
        const lower = this.#resolveExpression(expression.lower, scope, ctes, subject);
        const upper = this.#resolveExpression(expression.upper, scope, ctes, subject);
        return {
          tsType: "boolean",
          nullable: subject.nullable || lower.nullable || upper.nullable,
          databaseType: "boolean",
        };
      }
    }
  }

  #resolveBinary(
    expression: Extract<Expression, { readonly kind: "binary" }>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
    let left: ResolvedType;
    let right: ResolvedType;
    if (expression.left.kind === "parameter" && expression.right.kind !== "parameter") {
      right = this.#resolveExpression(expression.right, scope, ctes);
      left = this.#resolveExpression(expression.left, scope, ctes, right);
    } else {
      left = this.#resolveExpression(expression.left, scope, ctes);
      right = this.#resolveExpression(
        expression.right,
        scope,
        ctes,
        expression.right.kind === "parameter" ? left : undefined,
      );
    }
    if (booleanOperators.has(expression.operator)) {
      const neverNull = expression.operator.startsWith("IS");
      return {
        tsType: "boolean",
        nullable: neverNull ? false : left.nullable || right.nullable,
        databaseType: "boolean",
      };
    }
    if (["->", "#>"].includes(expression.operator))
      return { tsType: this.#policy.json, nullable: true, databaseType: "jsonb" };
    if (["->>", "#>>"].includes(expression.operator)) return { tsType: "string", nullable: true, databaseType: "text" };
    if (expression.operator === "||") {
      if (left.tsType.startsWith("readonly (") && right.tsType.startsWith("readonly (")) {
        const databaseType = left.databaseType ?? right.databaseType;
        return {
          tsType: unionTypeLiterals([left.tsType, right.tsType]),
          nullable: left.nullable || right.nullable,
          ...(databaseType === undefined ? {} : { databaseType }),
        };
      }
      return { tsType: "string", nullable: left.nullable || right.nullable, databaseType: "text" };
    }
    const leftDatabase = left.databaseType === undefined ? undefined : normalizeDatabaseType(left.databaseType);
    const rightDatabase = right.databaseType === undefined ? undefined : normalizeDatabaseType(right.databaseType);
    if (
      leftDatabase !== undefined &&
      rightDatabase !== undefined &&
      numericTypes.has(leftDatabase) &&
      numericTypes.has(rightDatabase)
    ) {
      const databaseType = [leftDatabase, rightDatabase].some((type) => type === "numeric" || type === "decimal")
        ? "numeric"
        : "double precision";
      return {
        tsType: databaseType === "numeric" ? this.#policy.numeric : "number",
        nullable: left.nullable || right.nullable,
        databaseType,
      };
    }
    if (left.tsType === "unknown" || right.tsType === "unknown")
      return { tsType: "unknown", nullable: left.nullable || right.nullable };
    this.#diagnostic(
      "TSQ203",
      `Cannot safely infer operator ${expression.operator} for ${leftDatabase ?? left.tsType} and ${rightDatabase ?? right.tsType}`,
      expression.range,
    );
    return { tsType: "unknown", nullable: true };
  }

  #resolveColumn(relationIdentifier: Identifier | undefined, columnIdentifier: Identifier, scope: Scope): ResolvedType {
    const name = sqlName(columnIdentifier);
    if (scope.relations.length === 0 && this.#diagnostics.some((diagnostic) => diagnostic.code === "TSQ100")) {
      return { tsType: "unknown", nullable: true };
    }
    if (relationIdentifier === undefined) {
      const using = scope.usingColumns.get(name);
      if (using !== undefined) return using;
    }
    const matches = this.#columnMatches(relationIdentifier, name, scope, columnIdentifier.quoted);
    if (matches.length > 1) {
      this.#diagnostic(
        "TSQ102",
        `Ambiguous column ${columnIdentifier.name}`,
        columnIdentifier.range,
        "Qualify the column with a table alias.",
      );
      return { tsType: "unknown", nullable: true };
    }
    if (matches.length === 0) {
      if (scope.outer !== undefined) return this.#resolveColumn(relationIdentifier, columnIdentifier, scope.outer);
      if (relationIdentifier !== undefined && !this.#relation(scope, sqlName(relationIdentifier))) {
        this.#diagnostic(
          "TSQ103",
          `Unknown relation alias ${relationIdentifier.name}`,
          relationIdentifier.range,
          suggestion(
            sqlName(relationIdentifier),
            scope.relations.map((item) => item.alias),
          ),
        );
      } else {
        const candidates = scope.relations.flatMap((relation) => Object.keys(relation.table.columns));
        this.#diagnostic(
          "TSQ101",
          `Unknown column ${columnIdentifier.name}`,
          columnIdentifier.range,
          suggestion(name, candidates),
        );
      }
      return { tsType: "unknown", nullable: true };
    }
    const [relation, column] = matches[0]!;
    return this.#columnType(relation, column);
  }

  #columnMatches(
    relationIdentifier: Identifier | undefined,
    name: string,
    scope: Scope,
    quoted: boolean,
  ): readonly [Relation, ColumnSnapshot][] {
    if (relationIdentifier !== undefined) {
      const relation = this.#relation(scope, sqlName(relationIdentifier));
      const column = relation === undefined ? undefined : this.#column(relation, name, quoted);
      return relation === undefined || column === undefined ? [] : [[relation, column]];
    }
    return scope.relations.flatMap((relation): readonly [Relation, ColumnSnapshot][] => {
      const column = this.#column(relation, name, quoted);
      return column === undefined ? [] : [[relation, column]];
    });
  }

  #relation(scope: Scope, alias: string): Relation | undefined {
    return scope.relations.find((candidate) => candidate.alias === alias);
  }

  #column(relation: Relation, name: string, quoted = false): ColumnSnapshot | undefined {
    return this.#index.column(relation.table, name, quoted);
  }

  #findColumn(table: TableSnapshot | undefined, identifier: Identifier): ColumnSnapshot | undefined {
    const name = sqlName(identifier);
    const column = table === undefined ? undefined : this.#index.column(table, name, identifier.quoted);
    if (column === undefined)
      this.#diagnostic(
        "TSQ101",
        `Unknown column ${name}`,
        identifier.range,
        suggestion(name, Object.keys(table?.columns ?? {})),
      );
    return column;
  }

  #columnType(relation: Relation, column: ColumnSnapshot): ResolvedType {
    return { tsType: column.tsType, nullable: column.nullable || relation.nullable, databaseType: column.databaseType };
  }

  #resolveCall(expression: CallExpression, scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): ResolvedType {
    const resolved = expression.arguments.map((argument) => this.#resolveExpression(argument, scope, ctes));
    if (expression.filter !== undefined) this.#resolveExpression(expression.filter, scope, ctes);
    if (expression.over !== undefined && "partitionBy" in expression.over) {
      for (const item of expression.over.partitionBy) this.#resolveExpression(item, scope, ctes);
      for (const item of expression.over.orderBy) this.#resolveExpression(item.expression, scope, ctes);
    }
    const name = expression.name.name.toUpperCase();
    if (name === "COUNT") return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint" };
    if (name === "COALESCE") {
      const known = resolved.filter((_, index) => {
        const argument = expression.arguments[index];
        return argument?.kind !== "literal" || argument.value !== null;
      });
      return {
        tsType: unionTypeLiterals(known.map((result) => result.tsType)),
        nullable: resolved.every((result) => result.nullable),
        ...(known.length > 0 &&
        known.every((result) => result.databaseType === known[0]?.databaseType) &&
        known[0]?.databaseType !== undefined
          ? { databaseType: known[0].databaseType }
          : {}),
      };
    }
    if (name === "NULLIF") return { ...(resolved[0] ?? { tsType: "unknown" }), nullable: true };
    if (["MIN", "MAX", "GREATEST", "LEAST"].includes(name))
      return {
        ...(resolved[0] ?? { tsType: "unknown", nullable: true }),
        nullable: name === "MIN" || name === "MAX" ? true : resolved.some((result) => result.nullable),
      };
    if (name === "SUM" || name === "AVG")
      return {
        tsType: resolved[0]?.tsType ?? this.#policy.numeric,
        nullable: true,
        databaseType: resolved[0]?.databaseType ?? "numeric",
      };
    if (["BOOL_AND", "BOOL_OR", "EVERY"].includes(name))
      return { tsType: "boolean", nullable: true, databaseType: "boolean" };
    if (name === "STRING_AGG") return { tsType: "string", nullable: true, databaseType: "text" };
    if (["JSON_AGG", "JSONB_AGG", "JSON_OBJECT_AGG", "JSONB_OBJECT_AGG"].includes(name))
      return { tsType: this.#policy.json, nullable: true, databaseType: name.startsWith("JSONB") ? "jsonb" : "json" };
    if (name === "ARRAY_AGG") {
      const item = resolved[0] ?? { tsType: "unknown", nullable: true };
      return {
        tsType: `readonly (${item.tsType}${item.nullable ? " | null" : ""})[]`,
        nullable: true,
        ...(item.databaseType === undefined ? {} : { databaseType: `${item.databaseType}[]` }),
      };
    }

    const functionName = sqlName(expression.name);
    const schemaName = expression.schema === undefined ? undefined : sqlName(expression.schema);
    const candidates = this.#index.functions(functionName, expression.arguments.length, schemaName);
    const exact = candidates.filter((candidate) =>
      candidate.argumentTypes.every((type, index) => {
        const actual = resolved[index]?.databaseType;
        return actual === undefined || this.#typesCompatible(type, actual);
      }),
    );
    const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (selected !== undefined) {
      expression.arguments.forEach((argument, index) => {
        if (argument.kind === "parameter") {
          this.#resolveExpression(argument, scope, ctes, this.#databaseType(selected.argumentTypes[index]!, true));
        }
      });
      return this.#functionType(selected);
    }
    if (exact.length > 1 || candidates.length > 1) {
      this.#diagnostic(
        "TSQ204",
        `Ambiguous overloaded function ${expression.name.name}`,
        expression.range,
        "Cast arguments to select a specific overload.",
      );
      return { tsType: "unknown", nullable: true };
    }
    this.#diagnostic("TSQ202", `Unknown function ${expression.name.name}`, expression.range, undefined, "warning");
    return { tsType: "unknown", nullable: true };
  }

  #typesCompatible(expected: string, actual: string): boolean {
    const left = normalizeDatabaseType(expected);
    const right = normalizeDatabaseType(actual);
    if (left === right) return true;
    if (numericTypes.has(left) && numericTypes.has(right)) return true;
    return false;
  }

  #functionType(value: FunctionSnapshot): ResolvedType {
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

  #databaseType(databaseType: string, nullable: boolean): ResolvedType {
    return {
      tsType: mapPostgresType(databaseType, this.#policy, this.#schema),
      nullable,
      databaseType: normalizeDatabaseType(databaseType),
    };
  }

  #recordParameter(index: number, expected: ResolvedType | undefined): ResolvedType {
    return this.#parameters.record(index, expected);
  }

  #diagnostic(
    code: string,
    message: string,
    range: SourceRange,
    suggestionText?: string,
    severity: SqlDiagnostic["severity"] = "error",
  ): void {
    this.#diagnostics.push({
      code,
      message,
      range,
      severity,
      ...(suggestionText === undefined ? {} : { suggestion: suggestionText }),
    });
  }
}

export function resolveStatement(
  statement: Statement,
  schema: SchemaSnapshot,
  options: ResolveOptions = {},
): ResolvedQuery {
  return new Resolver(schema, options).resolve(statement);
}

export function resolveSelect(
  statement: SelectStatement,
  schema: SchemaSnapshot,
  options: ResolveOptions = {},
): ResolvedQuery {
  return resolveStatement(statement, schema, options);
}

export { rowTypeLiteral } from "@typed-sql/core";
