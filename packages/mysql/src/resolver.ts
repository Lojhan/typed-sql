import { ParameterCollector, type ResolvedParameter, ResolverSchemaIndex, unionTypeLiterals } from "@typed-sql/core";
import type { ColumnSnapshot, FunctionSnapshot, SchemaSnapshot, TableSnapshot } from "@typed-sql/schema";
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
  WindowSpecification,
  WithClause,
} from "./parser/index.js";
import { walkStatement } from "./parser/index.js";
import { defaultMySqlTypePolicy, isKnownMySqlType, type MySqlTypePolicy, mapMySqlType } from "./type-policy.js";

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
  readonly outputAliases: Map<string, ResolvedType>;
  readonly outer?: Scope;
}

export interface ResolvedMySqlColumn extends ResolvedType {
  readonly name: string;
  readonly range: SourceRange;
}

export interface ResolvedMySqlQuery {
  readonly columns: readonly ResolvedMySqlColumn[];
  readonly parameters: readonly ResolvedParameter[];
  readonly diagnostics: readonly SqlDiagnostic[];
  readonly resultKind: "rows" | "command";
}

export interface ResolveMySqlOptions {
  readonly typePolicy?: MySqlTypePolicy;
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
  "<=>",
  "IS",
  "IS NOT",
  "LIKE",
  "NOT LIKE",
  "AND",
  "OR",
  "XOR",
]);

const aggregateFunctions = new Set([
  "AVG",
  "COUNT",
  "GROUP_CONCAT",
  "JSON_ARRAYAGG",
  "JSON_OBJECTAGG",
  "MAX",
  "MIN",
  "SUM",
]);
const windowAggregateFunctions = new Set(["AVG", "COUNT", "JSON_ARRAYAGG", "JSON_OBJECTAGG", "MAX", "MIN", "SUM"]);
const windowOnlyFunctions = new Set([
  "CUME_DIST",
  "DENSE_RANK",
  "FIRST_VALUE",
  "LAG",
  "LAST_VALUE",
  "LEAD",
  "NTH_VALUE",
  "NTILE",
  "PERCENT_RANK",
  "RANK",
  "ROW_NUMBER",
]);
const windowFunctionArity = new Map<string, readonly [number, number]>([
  ["CUME_DIST", [0, 0]],
  ["DENSE_RANK", [0, 0]],
  ["FIRST_VALUE", [1, 1]],
  ["LAG", [1, 3]],
  ["LAST_VALUE", [1, 1]],
  ["LEAD", [1, 3]],
  ["NTH_VALUE", [2, 2]],
  ["NTILE", [1, 1]],
  ["PERCENT_RANK", [0, 0]],
  ["RANK", [0, 0]],
  ["ROW_NUMBER", [0, 0]],
]);

function containsWindowFunction(expression: Expression): boolean {
  if (expression.kind === "call") {
    return expression.over !== undefined || expression.arguments.some(containsWindowFunction);
  }
  if (expression.kind === "array" || expression.kind === "row") return expression.elements.some(containsWindowFunction);
  if (expression.kind === "cast" || expression.kind === "unary") return containsWindowFunction(expression.expression);
  if (expression.kind === "binary") {
    return containsWindowFunction(expression.left) || containsWindowFunction(expression.right);
  }
  if (expression.kind === "case") {
    return (
      (expression.operand !== undefined && containsWindowFunction(expression.operand)) ||
      expression.branches.some(
        (branch) => containsWindowFunction(branch.when) || containsWindowFunction(branch.then),
      ) ||
      (expression.elseExpression !== undefined && containsWindowFunction(expression.elseExpression))
    );
  }
  if (expression.kind === "in") {
    return (
      containsWindowFunction(expression.expression) ||
      (!("kind" in expression.values) && expression.values.some(containsWindowFunction))
    );
  }
  if (expression.kind === "between") {
    return (
      containsWindowFunction(expression.expression) ||
      containsWindowFunction(expression.lower) ||
      containsWindowFunction(expression.upper)
    );
  }
  return false;
}

function containsAggregate(expression: Expression): boolean {
  if (expression.kind === "call") {
    return aggregateFunctions.has(expression.name.name.toUpperCase()) || expression.arguments.some(containsAggregate);
  }
  if (expression.kind === "array" || expression.kind === "row") return expression.elements.some(containsAggregate);
  if (expression.kind === "cast" || expression.kind === "unary") return containsAggregate(expression.expression);
  if (expression.kind === "binary") return containsAggregate(expression.left) || containsAggregate(expression.right);
  if (expression.kind === "case") {
    return (
      (expression.operand !== undefined && containsAggregate(expression.operand)) ||
      expression.branches.some((branch) => containsAggregate(branch.when) || containsAggregate(branch.then)) ||
      (expression.elseExpression !== undefined && containsAggregate(expression.elseExpression))
    );
  }
  if (expression.kind === "in") {
    return (
      containsAggregate(expression.expression) ||
      (!("kind" in expression.values) && expression.values.some(containsAggregate))
    );
  }
  if (expression.kind === "between") {
    return (
      containsAggregate(expression.expression) ||
      containsAggregate(expression.lower) ||
      containsAggregate(expression.upper)
    );
  }
  return false;
}

function expressionKey(expression: Expression): string {
  return JSON.stringify(expression, (key, value) => (key === "range" ? undefined : value));
}

function unaggregatedColumns(
  expression: Expression,
  insideAggregate = false,
): readonly Extract<Expression, { kind: "column" }>[] {
  if (expression.kind === "column") return insideAggregate ? [] : [expression];
  if (expression.kind === "call") {
    const exempt =
      aggregateFunctions.has(expression.name.name.toUpperCase()) || expression.name.name.toUpperCase() === "ANY_VALUE";
    return expression.arguments.flatMap((argument) => unaggregatedColumns(argument, insideAggregate || exempt));
  }
  if (expression.kind === "array" || expression.kind === "row") {
    return expression.elements.flatMap((element) => unaggregatedColumns(element, insideAggregate));
  }
  if (expression.kind === "cast" || expression.kind === "unary") {
    return unaggregatedColumns(expression.expression, insideAggregate);
  }
  if (expression.kind === "binary") {
    return [
      ...unaggregatedColumns(expression.left, insideAggregate),
      ...unaggregatedColumns(expression.right, insideAggregate),
    ];
  }
  if (expression.kind === "case") {
    return [
      ...(expression.operand === undefined ? [] : unaggregatedColumns(expression.operand, insideAggregate)),
      ...expression.branches.flatMap((branch) => [
        ...unaggregatedColumns(branch.when, insideAggregate),
        ...unaggregatedColumns(branch.then, insideAggregate),
      ]),
      ...(expression.elseExpression === undefined
        ? []
        : unaggregatedColumns(expression.elseExpression, insideAggregate)),
    ];
  }
  if (expression.kind === "in") {
    return [
      ...unaggregatedColumns(expression.expression, insideAggregate),
      ...("kind" in expression.values
        ? []
        : expression.values.flatMap((value) => unaggregatedColumns(value, insideAggregate))),
    ];
  }
  if (expression.kind === "between") {
    return [
      ...unaggregatedColumns(expression.expression, insideAggregate),
      ...unaggregatedColumns(expression.lower, insideAggregate),
      ...unaggregatedColumns(expression.upper, insideAggregate),
    ];
  }
  return [];
}

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

function unionMySqlTypes(types: readonly string[]): string {
  return unionTypeLiterals([...new Set(types.flatMap((type) => type.split(" | ")))]);
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: MySqlTypePolicy;
  readonly #strict: boolean;
  readonly #diagnostics: SqlDiagnostic[] = [];
  readonly #parameters = new ParameterCollector();
  readonly #index: ResolverSchemaIndex;
  #activeWindows: ReadonlyMap<string, WindowSpecification> = new Map();

  constructor(schema: SchemaSnapshot, options: ResolveMySqlOptions) {
    this.#schema = schema;
    this.#index = ResolverSchemaIndex.for(schema);
    this.#policy = options.typePolicy ?? defaultMySqlTypePolicy;
    this.#strict = options.strictExpressions ?? true;
  }

  resolve(statement: Statement): ResolvedMySqlQuery {
    if (this.#schema.dialect !== "mysql")
      this.#diagnostic("TSQ007", `MySQL resolver cannot analyze ${this.#schema.dialect}`, statement.range);
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
  ): Omit<ResolvedMySqlQuery, "diagnostics" | "parameters"> {
    const ctes = this.#with(statement.with, outer, inherited);
    if (statement.kind === "select") return { columns: this.#select(statement, outer, ctes), resultKind: "rows" };
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      outputAliases: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    const target = this.#relation(statement.table, false, scope, ctes);
    if (statement.kind === "insert") {
      const targets =
        statement.columns.length === 0
          ? Object.values(target?.table.columns ?? {})
          : statement.columns.map((column) => this.#findColumn(target?.table, column));
      if (target !== undefined && statement.columns.length > 0) {
        statement.columns.forEach((identifier, index) => {
          const column = targets[index];
          if (column !== undefined && this.#index.columnEligibility(target.table, column, "insert") === false) {
            this.#diagnostic("TSQ218", `Cannot INSERT into non-insertable column ${column.name}`, identifier.range);
          }
        });
        const supplied = new Set(statement.columns.map((column) => name(column).toLowerCase()));
        const required = this.#index.requiredInsertColumns(target.table);
        if (required !== "unknown") {
          for (const column of required) {
            if (!supplied.has(column.name.toLowerCase())) {
              this.#diagnostic("TSQ219", `INSERT omits required column ${column.name}`, statement.table.range);
            }
          }
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
      } else {
        this.#unsupported("MySQL does not support INSERT DEFAULT VALUES", statement.source.range);
      }
      if (statement.returning.length > 0)
        this.#unsupported("MySQL does not support INSERT RETURNING", statement.returning[0]!.range);
      return { columns: [], resultKind: "command" };
    }
    if (statement.kind === "update") {
      for (const assignment of statement.assignments) {
        const column = this.#findColumn(target?.table, assignment.column);
        if (
          target !== undefined &&
          column !== undefined &&
          this.#index.columnEligibility(target.table, column, "update") === false
        ) {
          this.#diagnostic("TSQ218", `Cannot UPDATE non-updatable column ${column.name}`, assignment.column.range);
        }
        this.#expression(assignment.value, scope, ctes, this.#snapshotType(column));
      }
      if (statement.from !== undefined) {
        this.#unsupported("MySQL does not support PostgreSQL-style UPDATE FROM", statement.from.range);
        this.#relation(statement.from, false, scope, ctes);
      }
      for (const join of statement.joins) this.#join(join, scope, ctes);
      if (statement.where !== undefined)
        this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
      if (statement.returning.length > 0)
        this.#unsupported("MySQL does not support UPDATE RETURNING", statement.returning[0]!.range);
      return { columns: [], resultKind: "command" };
    }
    for (const reference of statement.using) this.#relation(reference, false, scope, ctes);
    if (statement.where !== undefined)
      this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    if (statement.returning.length > 0)
      this.#unsupported("MySQL does not support DELETE RETURNING", statement.returning[0]!.range);
    return { columns: [], resultKind: "command" };
  }

  #with(
    withClause: WithClause | undefined,
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): Map<string, TableSnapshot> {
    const ctes = new Map(inherited);
    if (withClause === undefined) return ctes;
    for (const query of withClause.queries) {
      const key = name(query.name);
      if (ctes.has(key)) this.#diagnostic("TSQ211", `Duplicate CTE ${query.name.name}`, query.name.range);
      if (query.statement.kind !== "select") {
        this.#unsupported("MySQL CTE bodies must be SELECT statements", query.statement.range);
      }
      const selfReferences = query.statement.kind === "select" ? this.#selfReferences(query.statement, query.name) : 0;
      if (selfReferences > 0 && !withClause.recursive) {
        this.#diagnostic("TSQ220", `Recursive CTE ${query.name.name} requires WITH RECURSIVE`, query.range);
      }
      const result =
        query.statement.kind === "select" && selfReferences > 0 && withClause.recursive
          ? this.#recursiveCte(query as typeof query & { readonly statement: SelectStatement }, outer, ctes)
          : this.#statement(query.statement, outer, ctes);
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

  #recursiveCte(
    query: {
      readonly name: Identifier;
      readonly columns: readonly Identifier[];
      readonly statement: SelectStatement;
      readonly range: SourceRange;
    },
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedMySqlColumn[]; readonly resultKind: "rows" } {
    const arms = this.#selectArms(query.statement);
    const references = arms.map(({ statement }) => ({
      direct: this.#directSelfReferences(statement, query.name),
      total: this.#selfReferences(statement, query.name),
    }));
    const firstRecursive = references.findIndex(({ total }) => total > 0);
    let valid = true;
    const invalid = (message: string, range: SourceRange): void => {
      valid = false;
      this.#diagnostic("TSQ220", message, range);
    };
    if (arms.length < 2) invalid(`Recursive CTE ${query.name.name} must be a compound SELECT`, query.range);
    if (firstRecursive <= 0) {
      invalid(
        `Recursive CTE ${query.name.name} requires a non-recursive SELECT before its recursive member`,
        query.range,
      );
    }
    for (let index = 0; index < arms.length; index += 1) {
      const arm = arms[index]!;
      const reference = references[index]!;
      if (reference.total === 0) {
        if (firstRecursive >= 0 && index > firstRecursive) {
          invalid(`Non-recursive members of ${query.name.name} must precede recursive members`, arm.statement.range);
        }
        continue;
      }
      if (reference.direct !== 1 || reference.total !== 1) {
        invalid(
          `Each recursive member of ${query.name.name} must reference itself exactly once in its top-level FROM clause`,
          arm.statement.range,
        );
      }
      if (arm.operator !== "union") {
        invalid(`Recursive members of ${query.name.name} must be joined with UNION or UNION ALL`, arm.range);
      }
      if (this.#hasProhibitedRecursiveConstruct(arm.statement)) {
        valid = false;
        this.#diagnostic(
          "TSQ221",
          `Recursive member of ${query.name.name} cannot use DISTINCT, grouping, ordering, aggregate, or window functions`,
          arm.statement.range,
        );
      }
      if (
        arm.statement.joins.some(
          (join) =>
            join.kind === "left" &&
            join.table.kind === "table" &&
            join.table.schema === undefined &&
            name(join.table.name) === name(query.name),
        )
      ) {
        invalid(`Recursive CTE ${query.name.name} cannot be the right operand of a LEFT JOIN`, arm.statement.range);
      }
    }
    const seedColumns = this.#mergeCteSeedColumns(
      arms.slice(0, Math.max(firstRecursive, 0)).map(({ statement }) => statement),
      outer,
      inherited,
    );
    const provisional: Record<string, ColumnSnapshot> = {};
    const width = Math.max(query.columns.length, seedColumns.length);
    for (let index = 0; index < width; index += 1) {
      const seed = seedColumns[index];
      const columnName = query.columns[index] === undefined ? seed?.name : name(query.columns[index]!);
      if (columnName === undefined) continue;
      provisional[columnName] = {
        name: columnName,
        databaseType: seed?.databaseType ?? "unknown",
        tsType: seed?.tsType ?? "unknown",
        nullable: seed?.nullable ?? true,
      };
    }
    const recursiveScope = new Map(inherited);
    recursiveScope.set(name(query.name), { name: name(query.name), columns: provisional });
    const analyzed = this.#select(query.statement, outer, recursiveScope);
    const columns = Object.values(provisional).map(
      (column, index): ResolvedMySqlColumn => ({
        name: column.name,
        tsType: column.tsType,
        nullable: true,
        databaseType: column.databaseType,
        range: seedColumns[index]?.range ?? query.range,
      }),
    );
    if (!valid && analyzed.length === 0) {
      return {
        columns: Object.values(provisional).map((column) => ({
          name: column.name,
          tsType: "unknown",
          nullable: true,
          databaseType: "unknown",
          range: query.range,
        })),
        resultKind: "rows",
      };
    }
    return { columns: columns.length > 0 ? columns : analyzed, resultKind: "rows" };
  }

  #selectArms(statement: SelectStatement): readonly {
    readonly statement: SelectStatement;
    readonly operator?: "union" | "intersect" | "except";
    readonly all?: boolean;
    readonly range: SourceRange;
  }[] {
    const { compounds, ...simple } = statement;
    const arms: {
      statement: SelectStatement;
      operator?: "union" | "intersect" | "except";
      all?: boolean;
      range: SourceRange;
    }[] = [{ statement: { ...simple, compounds: [] }, range: statement.range }];
    for (const compound of compounds) {
      const nested = this.#selectArms(compound.statement);
      const [first, ...rest] = nested;
      if (first !== undefined) {
        arms.push({
          statement: first.statement,
          operator: compound.operator,
          all: compound.all,
          range: compound.range,
        });
      }
      arms.push(...rest);
    }
    return arms;
  }

  #directSelfReferences(statement: SelectStatement, identifier: Identifier): number {
    return [statement.from, ...statement.joins.map(({ table }) => table)].filter(
      (reference) =>
        reference?.kind === "table" && reference.schema === undefined && name(reference.name) === name(identifier),
    ).length;
  }

  #selfReferences(statement: SelectStatement, identifier: Identifier): number {
    let references = 0;
    walkStatement(statement, {
      table(reference) {
        if (reference.kind === "table" && reference.schema === undefined && name(reference.name) === name(identifier)) {
          references += 1;
        }
      },
    });
    return references;
  }

  #hasProhibitedRecursiveConstruct(statement: SelectStatement): boolean {
    let prohibited =
      statement.distinct ||
      statement.groupBy.length > 0 ||
      statement.having !== undefined ||
      statement.windows.length > 0 ||
      statement.orderBy.length > 0;
    walkStatement(statement, {
      expression(expression) {
        if (
          expression.kind === "call" &&
          (expression.over !== undefined || aggregateFunctions.has(expression.name.name.toUpperCase()))
        ) {
          prohibited = true;
        }
      },
    });
    return prohibited;
  }

  #mergeCteSeedColumns(
    statements: readonly SelectStatement[],
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedMySqlColumn[] {
    const merged: ResolvedMySqlColumn[] = [];
    for (const statement of statements) {
      const probe = new Resolver(this.#schema, { typePolicy: this.#policy, strictExpressions: false });
      const columns = probe.#select(statement, outer, inherited);
      if (merged.length === 0) {
        merged.push(...columns);
        continue;
      }
      for (let index = 0; index < Math.min(merged.length, columns.length); index += 1) {
        const current = merged[index]!;
        const candidate = columns[index]!;
        merged[index] = {
          name: current.name,
          tsType: unionMySqlTypes([current.tsType, candidate.tsType]),
          nullable: current.nullable || candidate.nullable,
          ...(current.databaseType === candidate.databaseType && current.databaseType !== undefined
            ? { databaseType: current.databaseType }
            : {}),
          range: current.range,
        };
      }
    }
    return merged;
  }

  #select(
    statement: SelectStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedMySqlColumn[] {
    const previousWindows = this.#activeWindows;
    this.#activeWindows = this.#windows(statement);
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      outputAliases: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    if (statement.distinctOn.length > 0)
      this.#unsupported("MySQL does not support DISTINCT ON", statement.distinctOn[0]!.range);
    if (statement.from !== undefined) this.#relation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#join(join, scope, ctes);
    if (statement.compounds.length > 0 && statement.locking.length > 0 && statement.parenthesized !== true) {
      this.#unsupported(
        "A locking clause on a MySQL set-operation arm requires parentheses",
        statement.locking[0]!.range,
      );
    }
    const lockingTargets = new Set<string>();
    for (const clause of statement.locking) {
      if (statement.locking.length > 1 && clause.relations.length === 0) {
        this.#unsupported("Multiple MySQL locking clauses require an OF target", clause.range);
      }
      for (const relation of clause.relations) {
        const target = name(relation);
        if (!scope.relations.some(({ alias }) => alias === target)) {
          this.#diagnostic("TSQ103", `Unknown locking relation ${relation.name}`, relation.range);
        } else if (lockingTargets.has(target)) {
          this.#unsupported(`MySQL locking relation ${relation.name} is repeated`, relation.range);
        }
        lockingTargets.add(target);
      }
    }
    const prohibitedWindowExpressions = [
      statement.where,
      statement.having,
      statement.limit,
      statement.offset,
      ...statement.groupBy,
      ...statement.joins.map(({ on }) => on),
      ...statement.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...specification.orderBy.map(({ expression }) => expression),
      ]),
    ].filter((expression): expression is Expression => expression !== undefined);
    for (const expression of prohibitedWindowExpressions) {
      if (containsWindowFunction(expression)) {
        this.#diagnostic(
          "TSQ223",
          "Window functions are only allowed in SELECT results and ORDER BY",
          expression.range,
        );
      }
    }
    if (statement.where !== undefined)
      this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    const columns =
      statement.queryValues === undefined
        ? [...this.#items(statement.columns, scope, ctes)]
        : this.#valuesColumns(statement.queryValues, scope, ctes);
    if (statement.groupRollup === true) {
      const groupingKeys = new Set(
        statement.groupBy.map((grouping) => {
          if (grouping.kind !== "column" || grouping.relation !== undefined) return expressionKey(grouping);
          const aliased = statement.columns.find(
            (item) => item.alias !== undefined && name(item.alias) === name(grouping.column),
          );
          return expressionKey(aliased?.expression ?? grouping);
        }),
      );
      for (const item of statement.columns) {
        if (!groupingKeys.has(expressionKey(item.expression))) continue;
        const outputName = item.alias === undefined ? this.#outputName(item.expression) : name(item.alias);
        const index = columns.findIndex((column) => column.name === outputName);
        if (index >= 0) columns[index] = { ...columns[index]!, nullable: true };
      }
    }
    for (const window of statement.windows) {
      const effective = this.#activeWindows.get(name(window.name)) ?? window.specification;
      for (const value of effective.partitionBy) this.#expression(value, scope, ctes);
      for (const item of effective.orderBy) this.#expression(item.expression, scope, ctes);
      this.#windowFrame(effective, scope, ctes);
    }
    statement.columns.forEach((item) => {
      const alias = item.alias;
      const output = alias === undefined ? undefined : columns.find((column) => column.name === name(alias));
      if (alias !== undefined && output !== undefined) {
        const { name: _name, range: _range, ...type } = output;
        scope.outputAliases.set(name(alias), type);
      }
    });
    for (const value of statement.groupBy) this.#expression(value, scope, ctes);
    if (statement.having !== undefined)
      this.#expression(statement.having, scope, ctes, this.#databaseType("boolean", false));
    this.#validateGroupedQuery(statement, scope);
    const outputNames = new Set(columns.map((column) => column.name));
    for (const item of statement.orderBy) {
      if (statement.compounds.length > 0 || statement.queryValues !== undefined) {
        const validName =
          item.expression.kind === "column" &&
          item.expression.relation === undefined &&
          outputNames.has(name(item.expression.column));
        const validPosition =
          item.expression.kind === "literal" &&
          typeof item.expression.value === "number" &&
          Number.isInteger(item.expression.value) &&
          item.expression.value >= 1 &&
          item.expression.value <= columns.length;
        if (!validName && !validPosition) {
          this.#diagnostic(
            "TSQ228",
            "A compound-query ORDER BY item must name or position a result column",
            item.range,
          );
        }
      } else this.#expression(item.expression, scope, ctes);
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
        columns[index] = {
          name: left.name,
          tsType: unionMySqlTypes([left.tsType, candidate.tsType]),
          nullable: left.nullable || candidate.nullable,
          ...(left.databaseType === candidate.databaseType && left.databaseType !== undefined
            ? { databaseType: left.databaseType }
            : {}),
          range: left.range,
        };
      }
    }
    this.#activeWindows = previousWindows;
    return columns;
  }

  #valuesColumns(
    values: NonNullable<SelectStatement["queryValues"]>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedMySqlColumn[] {
    const first = values.rows[0] ?? [];
    const columns = first.map(
      (expression, index): ResolvedMySqlColumn => ({
        name: `column_${index}`,
        ...this.#expression(expression, scope, ctes),
        range: expression.range,
      }),
    );
    for (const row of values.rows.slice(1)) {
      if (row.length !== columns.length) {
        this.#diagnostic(
          "TSQ214",
          `VALUES has ${columns.length} columns in its first row and ${row.length} in a later row`,
          values.range,
        );
      }
      row.forEach((expression, index) => {
        const candidate = this.#expression(expression, scope, ctes, columns[index]);
        const current = columns[index];
        if (current === undefined) return;
        if (expression.kind === "literal" && expression.value === null) {
          columns[index] = { ...current, nullable: true };
          return;
        }
        if (first[index]?.kind === "literal" && first[index].value === null) {
          columns[index] = { name: current.name, ...candidate, nullable: true, range: current.range };
          return;
        }
        columns[index] = {
          name: current.name,
          tsType: unionMySqlTypes([current.tsType, candidate.tsType]),
          nullable: current.nullable || candidate.nullable,
          ...(current.databaseType === candidate.databaseType && current.databaseType !== undefined
            ? { databaseType: current.databaseType }
            : {}),
          range: current.range,
        };
      });
    }
    return columns;
  }

  #windows(statement: SelectStatement): ReadonlyMap<string, WindowSpecification> {
    const raw = new Map<string, WindowSpecification>();
    for (const window of statement.windows) {
      const key = name(window.name);
      if (raw.has(key)) {
        this.#diagnostic("TSQ222", `Duplicate window ${window.name.name}`, window.name.range);
      } else raw.set(key, window.specification);
    }
    let inlineWindows = 0;
    walkStatement(statement, {
      expression(expression, owner) {
        if (
          owner === statement &&
          expression.kind === "call" &&
          expression.over !== undefined &&
          "partitionBy" in expression.over
        ) {
          inlineWindows += 1;
        }
      },
    });
    if (raw.size + inlineWindows > 127) {
      this.#diagnostic("TSQ222", "MySQL permits at most 127 distinct windows per SELECT", statement.range);
    }
    const resolved = new Map<string, WindowSpecification>();
    const resolving = new Set<string>();
    const resolve = (key: string): WindowSpecification | undefined => {
      const cached = resolved.get(key);
      if (cached !== undefined) return cached;
      const specification = raw.get(key);
      if (specification === undefined) return undefined;
      if (resolving.has(key)) {
        this.#diagnostic("TSQ222", `Named window ${key} participates in a reference cycle`, specification.range);
        return specification;
      }
      resolving.add(key);
      const effective = this.#effectiveWindow(
        specification,
        specification.base === undefined ? undefined : resolve(name(specification.base)),
      );
      resolving.delete(key);
      resolved.set(key, effective);
      return effective;
    };
    for (const key of raw.keys()) resolve(key);
    return resolved;
  }

  #effectiveWindow(
    specification: WindowSpecification,
    knownBase: WindowSpecification | undefined = specification.base === undefined
      ? undefined
      : this.#activeWindows.get(name(specification.base)),
  ): WindowSpecification {
    if (specification.base === undefined) {
      this.#validateWindowFrame(specification);
      return specification;
    }
    if (knownBase === undefined) {
      this.#diagnostic("TSQ222", `Unknown base window ${specification.base.name}`, specification.base.range);
      this.#validateWindowFrame(specification);
      return specification;
    }
    if (knownBase.partitionBy.length > 0 && specification.partitionBy.length > 0) {
      this.#diagnostic("TSQ222", "A derived window cannot replace PARTITION BY", specification.range);
    }
    if (knownBase.orderBy.length > 0 && specification.orderBy.length > 0) {
      this.#diagnostic("TSQ222", "A derived window cannot replace ORDER BY", specification.range);
    }
    if (knownBase.frame !== undefined) {
      this.#diagnostic("TSQ222", "A framed window cannot be used as a base window", specification.base.range);
    }
    const effective: WindowSpecification = {
      ...specification,
      partitionBy: knownBase.partitionBy.length > 0 ? knownBase.partitionBy : specification.partitionBy,
      orderBy: knownBase.orderBy.length > 0 ? knownBase.orderBy : specification.orderBy,
    };
    this.#validateWindowFrame(effective);
    return effective;
  }

  #validateWindowFrame(specification: WindowSpecification): void {
    const frame = specification.frame;
    if (frame === undefined) return;
    if (frame.start.kind === "unbounded-following") {
      this.#diagnostic("TSQ222", "A window frame cannot start with UNBOUNDED FOLLOWING", frame.start.range);
    }
    if (frame.end?.kind === "unbounded-preceding") {
      this.#diagnostic("TSQ222", "A window frame cannot end with UNBOUNDED PRECEDING", frame.end.range);
    }
    if (frame.end === undefined && (frame.start.kind === "following" || frame.start.kind === "unbounded-following")) {
      this.#diagnostic("TSQ222", "A single-bound window frame must end at CURRENT ROW", frame.start.range);
    }
    const ranks = new Map<string, number>([
      ["unbounded-preceding", 0],
      ["preceding", 1],
      ["current-row", 2],
      ["following", 3],
      ["unbounded-following", 4],
    ]);
    if (frame.end !== undefined && ranks.get(frame.start.kind)! > ranks.get(frame.end.kind)!) {
      this.#diagnostic("TSQ222", "A window frame start cannot follow its end", frame.range);
    }
    const hasOffset = [frame.start, frame.end].some(
      (boundary) => boundary?.kind === "preceding" || boundary?.kind === "following",
    );
    if (frame.unit === "range" && hasOffset && specification.orderBy.length !== 1) {
      this.#diagnostic("TSQ222", "A RANGE offset frame requires exactly one ORDER BY expression", frame.range);
    }
  }

  #windowFrame(specification: WindowSpecification, scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const frame = specification.frame;
    if (frame === undefined) return;
    for (const boundary of [frame.start, frame.end]) {
      if (boundary?.kind !== "preceding" && boundary?.kind !== "following") continue;
      if (
        boundary.expression.kind !== "parameter" &&
        (boundary.expression.kind !== "literal" ||
          typeof boundary.expression.value !== "number" ||
          !Number.isInteger(boundary.expression.value) ||
          boundary.expression.value < 0)
      ) {
        this.#diagnostic(
          "TSQ222",
          "A MySQL window-frame offset must be a non-negative integer or parameter",
          boundary.range,
        );
      }
      this.#expression(boundary.expression, scope, ctes, this.#databaseType("int", false));
    }
  }

  #validateGroupedQuery(statement: SelectStatement, scope: Scope): void {
    const sqlMode = this.#schema.server?.settings.sqlMode;
    if (typeof sqlMode !== "string" || !sqlMode.split(",").includes("ONLY_FULL_GROUP_BY")) return;
    const clauseExpressions = [
      ...statement.columns.map(({ expression }) => expression),
      ...(statement.having === undefined ? [] : [statement.having]),
      ...statement.orderBy.map(({ expression }) => expression),
    ];
    if (statement.groupBy.length === 0 && !clauseExpressions.some(containsAggregate)) return;
    const groupingExpressions = statement.groupBy.map((grouping) => {
      if (grouping.kind !== "column" || grouping.relation !== undefined) return grouping;
      return (
        statement.columns.find((item) => item.alias !== undefined && name(item.alias) === name(grouping.column))
          ?.expression ?? grouping
      );
    });
    const groupedKeys = new Set(groupingExpressions.map(expressionKey));
    const groupedColumns = new Set(
      groupingExpressions
        .filter((expression): expression is Extract<Expression, { kind: "column" }> => expression.kind === "column")
        .map((expression) => this.#columnReferenceKey(expression, scope)),
    );
    const outputAliases = new Map(
      statement.columns.flatMap((item): readonly [string, Expression][] =>
        item.alias === undefined ? [] : [[name(item.alias), item.expression]],
      ),
    );
    const singleValueColumns = this.#singleValueColumns(statement.where, scope);
    const diagnosed = new Set<string>();
    for (const expression of clauseExpressions) {
      if (groupedKeys.has(expressionKey(expression))) continue;
      for (const column of unaggregatedColumns(expression)) {
        const validate = (candidate: typeof column, seenAliases = new Set<string>()): void => {
          const aliasName = candidate.relation === undefined ? name(candidate.column) : undefined;
          const alias = aliasName === undefined ? undefined : outputAliases.get(aliasName);
          if (aliasName !== undefined && alias !== undefined && !seenAliases.has(aliasName)) {
            seenAliases.add(aliasName);
            for (const nested of unaggregatedColumns(alias)) validate(nested, seenAliases);
            return;
          }
          const key = this.#columnReferenceKey(candidate, scope);
          if (
            groupedColumns.has(key) ||
            singleValueColumns.has(key) ||
            this.#functionallyDependent(candidate, groupedColumns, scope) ||
            diagnosed.has(`${key}:${candidate.range.start}`)
          ) {
            return;
          }
          diagnosed.add(`${key}:${candidate.range.start}`);
          this.#diagnostic(
            "TSQ228",
            `Column ${candidate.column.name} is neither grouped nor functionally dependent on grouped columns`,
            candidate.range,
          );
        };
        validate(column);
      }
    }
  }

  #singleValueColumns(expression: Expression | undefined, scope: Scope): ReadonlySet<string> {
    const columns = new Set<string>();
    const visit = (value: Expression): void => {
      if (value.kind === "binary" && value.operator === "AND") {
        visit(value.left);
        visit(value.right);
        return;
      }
      if (value.kind !== "binary" || value.operator !== "=") return;
      const column =
        value.left.kind === "column" && this.#isSingleValueExpression(value.right)
          ? value.left
          : value.right.kind === "column" && this.#isSingleValueExpression(value.left)
            ? value.right
            : undefined;
      if (column !== undefined) columns.add(this.#columnReferenceKey(column, scope));
    };
    if (expression !== undefined) visit(expression);
    return columns;
  }

  #isSingleValueExpression(expression: Expression): boolean {
    if (expression.kind === "literal" || expression.kind === "parameter") return true;
    return expression.kind === "cast" && this.#isSingleValueExpression(expression.expression);
  }

  #columnReferenceKey(expression: Extract<Expression, { kind: "column" }>, scope: Scope): string {
    if (expression.relation !== undefined) return `${name(expression.relation)}.${name(expression.column)}`;
    const matches = scope.relations.filter(({ table }) => this.#column(table, name(expression.column)) !== undefined);
    return matches.length === 1 ? `${matches[0]!.alias}.${name(expression.column)}` : name(expression.column);
  }

  #functionallyDependent(
    expression: Extract<Expression, { kind: "column" }>,
    groupedColumns: ReadonlySet<string>,
    scope: Scope,
  ): boolean {
    const relation =
      expression.relation === undefined
        ? scope.relations.filter(({ table }) => this.#column(table, name(expression.column)) !== undefined)[0]
        : scope.relations.find(({ alias }) => alias === name(expression.relation!));
    if (relation === undefined) return false;
    return this.#index.uniqueColumnSets(relation.table).some((columns) =>
      columns.every((column) => {
        const snapshot = this.#column(relation.table, column);
        return snapshot?.nullable === false && groupedColumns.has(`${relation.alias}.${column.toLowerCase()}`);
      }),
    );
  }

  #join(join: SelectStatement["joins"][number], scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const previous = [...scope.relations];
    if (join.kind === "full") this.#unsupported("MySQL does not support FULL JOIN", join.range);
    if (join.kind === "right" || join.kind === "full") for (const relation of previous) relation.nullable = true;
    const relation = this.#relation(
      join.table,
      join.kind === "left" || join.kind === "full",
      scope,
      ctes,
      join.kind !== "right",
    );
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
    allowLateralScope = true,
  ): Relation | undefined {
    let table: TableSnapshot | undefined;
    let alias: string;
    if (reference.kind === "subquery") {
      const result = this.#statement(
        reference.query,
        reference.lateral && allowLateralScope ? scope : scope.outer,
        ctes,
      );
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
  ): readonly ResolvedMySqlColumn[] {
    const columns: ResolvedMySqlColumn[] = [];
    const names = new Set<string>();
    const add = (column: ResolvedMySqlColumn): void => {
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
      if (typeof expression.value === "boolean") return { tsType: "boolean", nullable: false, databaseType: "boolean" };
      if (typeof expression.value === "number")
        return {
          tsType: "number",
          nullable: false,
          databaseType: Number.isInteger(expression.value) ? "int" : "decimal",
        };
      return { tsType: "string", nullable: false, databaseType: "varchar" };
    }
    if (expression.kind === "parameter") return this.#recordParameter(expression.index, expected);
    if (expression.kind === "star") return { tsType: "unknown", nullable: false };
    if (expression.kind === "array") {
      this.#unsupported("MySQL does not support ARRAY constructors", expression.range);
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
      if (!isKnownMySqlType(expression.databaseType.name, this.#schema))
        this.#diagnostic(
          "TSQ106",
          `Invalid or unknown MySQL cast type ${expression.databaseType.name}`,
          expression.databaseType.range,
        );
      return {
        tsType: mapMySqlType(expression.databaseType.name, this.#policy, this.#schema),
        nullable: source.nullable,
        databaseType: normalized(expression.databaseType.name),
      };
    }
    if (expression.kind === "unary") {
      const operand = this.#expression(expression.expression, scope, ctes);
      return expression.operator === "NOT"
        ? { tsType: "boolean", nullable: operand.nullable, databaseType: "boolean" }
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
      return { tsType: "boolean", nullable: false, databaseType: "boolean" };
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
      return { tsType: "boolean", nullable, databaseType: "boolean" };
    }
    const subject = this.#expression(expression.expression, scope, ctes);
    const values = [
      subject,
      this.#expression(expression.lower, scope, ctes, subject),
      this.#expression(expression.upper, scope, ctes, subject),
    ];
    return { tsType: "boolean", nullable: values.some((value) => value.nullable), databaseType: "boolean" };
  }

  #binary(
    expression: Extract<Expression, { readonly kind: "binary" }>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
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
        tsType: "boolean",
        nullable:
          expression.operator.startsWith("IS") || expression.operator === "<=>"
            ? false
            : left.nullable || right.nullable,
        databaseType: "boolean",
      };
    if (expression.operator === "->") return { tsType: this.#policy.json, nullable: true, databaseType: "json" };
    if (expression.operator === "->>") return { tsType: "string", nullable: true, databaseType: "varchar" };
    if (expression.operator === "||") {
      return left.tsType === "string" && right.tsType === "string"
        ? { tsType: "string", nullable: left.nullable || right.nullable, databaseType: "varchar" }
        : { tsType: "unknown", nullable: left.nullable || right.nullable };
    }
    const leftType = left.databaseType === undefined ? undefined : normalized(left.databaseType);
    const rightType = right.databaseType === undefined ? undefined : normalized(right.databaseType);
    if (
      leftType !== undefined &&
      rightType !== undefined &&
      numericTypes.has(leftType) &&
      numericTypes.has(rightType)
    ) {
      const decimal = leftType === "decimal" || rightType === "decimal" || expression.operator === "/";
      return {
        tsType: decimal ? this.#policy.decimal : "number",
        nullable: left.nullable || right.nullable,
        databaseType: decimal ? "decimal" : "double",
      };
    }
    if (left.tsType === "unknown" || right.tsType === "unknown")
      return { tsType: "unknown", nullable: left.nullable || right.nullable };
    this.#diagnostic("TSQ203", `Cannot safely infer MySQL operator ${expression.operator}`, expression.range);
    return { tsType: "unknown", nullable: true };
  }

  #call(expression: CallExpression, scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): ResolvedType {
    const functionName = expression.name.name.toUpperCase();
    if (expression.arguments.some(containsWindowFunction)) {
      this.#diagnostic("TSQ223", "MySQL does not support nested window functions", expression.range);
    }
    const values = expression.arguments.map((argument) => this.#expression(argument, scope, ctes));
    if (expression.filter !== undefined)
      this.#unsupported("MySQL does not support aggregate FILTER", expression.filter.range);
    if (expression.over !== undefined && "partitionBy" in expression.over) {
      const window = this.#effectiveWindow(expression.over);
      for (const value of window.partitionBy) this.#expression(value, scope, ctes);
      for (const item of window.orderBy) this.#expression(item.expression, scope, ctes);
      this.#windowFrame(window, scope, ctes);
    } else if (expression.over !== undefined && !this.#activeWindows.has(name(expression.over))) {
      this.#diagnostic("TSQ222", `Unknown window ${expression.over.name}`, expression.over.range);
    }
    if (expression.over !== undefined && expression.distinct) {
      this.#diagnostic("TSQ223", "MySQL does not support DISTINCT aggregate window functions", expression.range);
    }
    if (windowOnlyFunctions.has(functionName) && expression.over === undefined) {
      this.#diagnostic("TSQ223", `${functionName} requires an OVER clause`, expression.range);
    }
    if (
      expression.over !== undefined &&
      !windowOnlyFunctions.has(functionName) &&
      !windowAggregateFunctions.has(functionName)
    ) {
      this.#diagnostic("TSQ223", `${functionName} is not a MySQL window or aggregate function`, expression.range);
    }
    const expectedWindowArity = windowFunctionArity.get(functionName);
    if (
      expectedWindowArity !== undefined &&
      (values.length < expectedWindowArity[0] || values.length > expectedWindowArity[1])
    ) {
      this.#diagnostic("TSQ227", `${functionName} has an invalid argument count`, expression.range);
    }
    if (["ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE"].includes(functionName)) {
      return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint" };
    }
    if (["CUME_DIST", "PERCENT_RANK"].includes(functionName)) {
      return { tsType: "number", nullable: false, databaseType: "double" };
    }
    if (["LAG", "LEAD", "NTH_VALUE"].includes(functionName)) {
      return { ...(values[0] ?? { tsType: "unknown" }), nullable: true };
    }
    if (["FIRST_VALUE", "LAST_VALUE"].includes(functionName)) {
      return values[0] ?? { tsType: "unknown", nullable: true };
    }
    if (functionName === "GROUPING") {
      return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint unsigned" };
    }
    if (functionName === "ANY_VALUE") return values[0] ?? { tsType: "unknown", nullable: true };
    if (functionName === "COUNT") return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint" };
    if (["SUM", "AVG"].includes(functionName))
      return { tsType: this.#policy.decimal, nullable: true, databaseType: "decimal" };
    if (["MIN", "MAX"].includes(functionName)) return { ...(values[0] ?? { tsType: "unknown" }), nullable: true };
    if (functionName === "COALESCE")
      return {
        tsType: unionTypeLiterals(values.map((value) => value.tsType)),
        nullable: values.every((value) => value.nullable),
      };
    if (functionName === "IFNULL" || functionName === "NULLIF")
      return {
        ...(values[0] ?? { tsType: "unknown" }),
        nullable: functionName === "NULLIF" || values.every((value) => value.nullable),
      };
    if (functionName === "GROUP_CONCAT") return { tsType: "string", nullable: true, databaseType: "text" };
    if (["JSON_ARRAYAGG", "JSON_OBJECTAGG", "JSON_EXTRACT"].includes(functionName))
      return { tsType: this.#policy.json, nullable: true, databaseType: "json" };
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
      const output = scope.outputAliases.get(columnName);
      if (output !== undefined) return output;
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

  #databaseType(databaseType: string, nullable: boolean): ResolvedType {
    return {
      tsType: mapMySqlType(databaseType, this.#policy, this.#schema),
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

export function resolveMySqlStatement(
  statement: Statement,
  schema: SchemaSnapshot,
  options: ResolveMySqlOptions = {},
): ResolvedMySqlQuery {
  return new Resolver(schema, options).resolve(statement);
}
