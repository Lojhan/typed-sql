import {
  ParameterCollector,
  type ResolvedParameter,
  ResolverSchemaIndex,
  type StructuralRoutineSnapshot,
  unionTypeLiterals,
} from "@typed-sql/core";
import type { ColumnSnapshot, FunctionSnapshot, SchemaSnapshot, TableSnapshot } from "@typed-sql/schema";
import {
  isSqliteAggregateFunction,
  isSqliteWindowFunction,
  normalizeSqliteDatabaseType,
  resolveSqliteBuiltin,
  SQLITE_CURRENT_TIME_KEYWORDS,
  SQLITE_EXTENSION_TABLE_FUNCTIONS,
  SQLITE_JSON_TABLE_FUNCTIONS,
  SQLITE_MATH_FUNCTIONS,
  SQLITE_UNSUPPORTED_OPERATORS,
  type SqliteBuiltinDefinition,
  type SqliteBuiltinResolution,
  type SqliteTableFunctionDefinition,
  sqliteNumericOperands,
  sqliteOperator,
} from "./catalog/index.js";
import type {
  CallExpression,
  CommonTableExpression,
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
import { compareSqliteVersions, parseSqliteVersion, sqliteVersionSupport } from "./support.js";
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

function name(identifier: Identifier): string {
  return identifier.quoted ? identifier.name : identifier.name.toLowerCase();
}

function unionSqliteTypes(types: readonly string[]): string {
  const members = types.flatMap((type) => {
    const parts: string[] = [];
    let depth = 0;
    let quote: "'" | '"' | "`" | undefined;
    let start = 0;
    for (let index = 0; index < type.length; index += 1) {
      const character = type[index]!;
      if (quote !== undefined) {
        if (character === quote && type[index - 1] !== "\\") quote = undefined;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") quote = character;
      else if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") depth -= 1;
      else if (depth === 0 && type.slice(index, index + 3) === " | ") {
        parts.push(type.slice(start, index));
        start = index + 3;
        index += 2;
      }
    }
    parts.push(type.slice(start));
    return parts;
  });
  return unionTypeLiterals(members);
}

function containsWindowFunction(expression: Expression): boolean {
  if (expression.kind === "call") {
    return (
      expression.over !== undefined ||
      expression.arguments.some(containsWindowFunction) ||
      (expression.filter !== undefined && containsWindowFunction(expression.filter))
    );
  }
  if (expression.kind === "array" || expression.kind === "row") return expression.elements.some(containsWindowFunction);
  if (expression.kind === "cast" || expression.kind === "unary") return containsWindowFunction(expression.expression);
  if (expression.kind === "binary")
    return containsWindowFunction(expression.left) || containsWindowFunction(expression.right);
  if (expression.kind === "case")
    return (
      (expression.operand !== undefined && containsWindowFunction(expression.operand)) ||
      expression.branches.some(
        (branch) => containsWindowFunction(branch.when) || containsWindowFunction(branch.then),
      ) ||
      (expression.elseExpression !== undefined && containsWindowFunction(expression.elseExpression))
    );
  if (expression.kind === "in")
    return (
      containsWindowFunction(expression.expression) ||
      (!("kind" in expression.values) && expression.values.some(containsWindowFunction))
    );
  if (expression.kind === "between")
    return (
      containsWindowFunction(expression.expression) ||
      containsWindowFunction(expression.lower) ||
      containsWindowFunction(expression.upper)
    );
  return false;
}

function isConstantFrameExpression(expression: Expression): boolean {
  if (expression.kind === "literal" || expression.kind === "parameter") return true;
  if (expression.kind === "unary") return isConstantFrameExpression(expression.expression);
  if (expression.kind === "binary")
    return isConstantFrameExpression(expression.left) && isConstantFrameExpression(expression.right);
  return false;
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: SqliteTypePolicy;
  readonly #strict: boolean;
  readonly #diagnostics: SqlDiagnostic[] = [];
  readonly #parameters = new ParameterCollector();
  readonly #index: ResolverSchemaIndex;
  #activeWindows: ReadonlyMap<string, WindowSpecification> = new Map();

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
    const targetScope: Scope = {
      relations: target === undefined ? [] : [target],
      usingColumns: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    if (statement.kind === "insert") {
      const targets =
        statement.columns.length === 0
          ? Object.values(target?.table.columns ?? {}).filter(
              (column) => target === undefined || this.#insertable(target.table, column),
            )
          : statement.columns.map((column) => this.#findColumn(target?.table, column));
      if (target !== undefined && statement.columns.length > 0) {
        statement.columns.forEach((identifier, index) => {
          const column = targets[index];
          if (column !== undefined && !this.#insertable(target.table, column)) {
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
      }
      this.#upserts(statement, target, targetScope, ctes);
      return statement.returning.length === 0
        ? { columns: [], resultKind: "command" }
        : { columns: this.#returning(statement.returning, targetScope, ctes), resultKind: "rows" };
    }
    if (statement.kind === "update") {
      for (const assignment of statement.assignments) {
        const column = this.#findColumn(target?.table, assignment.column);
        if (target !== undefined && column !== undefined && !this.#updatable(target.table, column)) {
          this.#diagnostic("TSQ218", `Cannot UPDATE non-updatable column ${column.name}`, assignment.column.range);
        }
        this.#expression(assignment.value, scope, ctes, this.#snapshotType(column));
      }
      if (statement.from !== undefined) this.#relation(statement.from, false, scope, ctes);
      for (const join of statement.joins) this.#join(join, scope, ctes);
      if (statement.where !== undefined)
        this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
      return statement.returning.length === 0
        ? { columns: [], resultKind: "command" }
        : { columns: this.#returning(statement.returning, targetScope, ctes), resultKind: "rows" };
    }
    if (statement.using.length > 0) {
      this.#unsupported("SQLite does not support DELETE USING", statement.using[0]!.range);
    }
    for (const reference of statement.using) this.#relation(reference, false, scope, ctes);
    if (statement.where !== undefined)
      this.#expression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    return statement.returning.length === 0
      ? { columns: [], resultKind: "command" }
      : { columns: this.#returning(statement.returning, targetScope, ctes), resultKind: "rows" };
  }

  #upserts(
    statement: Extract<Statement, { readonly kind: "insert" }>,
    target: Relation | undefined,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): void {
    if (statement.upserts.length === 0) return;
    if (
      statement.source.kind === "select" &&
      statement.source.from !== undefined &&
      statement.source.where === undefined
    ) {
      this.#diagnostic(
        "TSQ224",
        "INSERT SELECT with UPSERT requires a WHERE clause to avoid SQLite's ON parsing ambiguity",
        statement.source.range,
        "Add WHERE TRUE before ON CONFLICT.",
      );
    }
    const excluded: Relation | undefined =
      target === undefined ? undefined : { alias: "excluded", table: target.table, nullable: false };
    const actionScope: Scope = {
      relations: [...scope.relations, ...(excluded === undefined ? [] : [excluded])],
      usingColumns: new Map(),
      ...(scope.outer === undefined ? {} : { outer: scope.outer }),
    };
    statement.upserts.forEach((upsert, upsertIndex) => {
      if (upsert.target.length === 0 && upsertIndex !== statement.upserts.length - 1)
        this.#diagnostic("TSQ224", "Only the final ON CONFLICT clause may omit its conflict target", upsert.range);
      if (upsert.target.length > 0 && target !== undefined)
        this.#validateConflictTarget(target.table, upsert.target, upsert.targetWhere !== undefined, upsert.range);
      for (const term of upsert.target) this.#expression(term.expression, scope, ctes);
      if (upsert.targetWhere !== undefined)
        this.#expression(upsert.targetWhere, scope, ctes, this.#databaseType("integer", false));
      if (upsert.action.kind === "nothing") return;
      for (const assignment of upsert.action.assignments) {
        const column = this.#findColumn(target?.table, assignment.column);
        if (target !== undefined && column !== undefined && !this.#updatable(target.table, column))
          this.#diagnostic("TSQ218", `Cannot UPDATE non-updatable column ${column.name}`, assignment.column.range);
        this.#expression(assignment.value, actionScope, ctes, this.#snapshotType(column));
      }
      if (upsert.action.where !== undefined)
        this.#expression(upsert.action.where, actionScope, ctes, this.#databaseType("integer", false));
    });
  }

  #validateConflictTarget(
    table: TableSnapshot,
    terms: Extract<Statement, { readonly kind: "insert" }>["upserts"][number]["target"],
    partial: boolean,
    range: SourceRange,
  ): void {
    const sqliteTable = table as TableSnapshot & {
      readonly indexes?: readonly {
        readonly unique: boolean;
        readonly partial: boolean;
        readonly columns: readonly {
          readonly name?: string;
          readonly expression?: boolean;
          readonly descending?: boolean;
          readonly collation?: string;
        }[];
      }[];
    };
    if (partial) {
      this.#diagnostic(
        "TSQ402",
        "Exact partial conflict-target matching requires normalized predicate evidence",
        range,
      );
      return;
    }
    const columns: { readonly name: string; readonly collation?: string }[] = [];
    for (const term of terms) {
      if (term.expression.kind !== "column" || term.expression.relation !== undefined) {
        this.#diagnostic(
          "TSQ402",
          "Exact expression conflict-target matching requires normalized index-expression evidence",
          term.range,
        );
        return;
      }
      columns.push({
        name: name(term.expression.column),
        ...(term.collation === undefined ? {} : { collation: name(term.collation) }),
      });
    }
    const primaryColumns = Object.values(table.columns)
      .map((column) => column as ColumnSnapshot & { readonly primaryKeyPosition?: number })
      .filter((column) => column.primaryKeyPosition !== undefined)
      .sort((left, right) => left.primaryKeyPosition! - right.primaryKeyPosition!)
      .map((column) => column.name.toLowerCase());
    const primaryMatch =
      !partial &&
      primaryColumns.length === columns.length &&
      primaryColumns.every((value, index) => value === columns[index]?.name) &&
      columns.every(({ collation }) => collation === undefined);
    const indexMatch = (sqliteTable.indexes ?? []).some(
      (index) =>
        index.unique &&
        !index.partial &&
        index.columns.length === columns.length &&
        index.columns.every((column, columnIndex) => {
          const requested = columns[columnIndex]!;
          return (
            !column.expression &&
            column.name?.toLowerCase() === requested.name &&
            (requested.collation === undefined || column.collation?.toLowerCase() === requested.collation)
          );
        }),
    );
    if (!primaryMatch && !indexMatch)
      this.#diagnostic("TSQ226", "Conflict target does not match a declared UNIQUE or PRIMARY KEY constraint", range);
  }

  #returning(
    items: readonly SelectItem[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): readonly ResolvedSqliteColumn[] {
    for (const item of items) {
      if (containsWindowFunction(item.expression) || this.#containsTopLevelAggregate(item.expression))
        this.#diagnostic(
          "TSQ225",
          "SQLite RETURNING cannot contain top-level aggregate or window functions",
          item.expression.range,
        );
    }
    return this.#items(items, scope, ctes);
  }

  #containsTopLevelAggregate(expression: Expression): boolean {
    if (expression.kind === "call")
      return (
        isSqliteAggregateFunction(expression.name.name) ||
        expression.arguments.some((argument) => this.#containsTopLevelAggregate(argument)) ||
        (expression.filter !== undefined && this.#containsTopLevelAggregate(expression.filter))
      );
    if (expression.kind === "array" || expression.kind === "row")
      return expression.elements.some((element) => this.#containsTopLevelAggregate(element));
    if (expression.kind === "cast" || expression.kind === "unary")
      return this.#containsTopLevelAggregate(expression.expression);
    if (expression.kind === "binary")
      return this.#containsTopLevelAggregate(expression.left) || this.#containsTopLevelAggregate(expression.right);
    if (expression.kind === "case")
      return (
        (expression.operand !== undefined && this.#containsTopLevelAggregate(expression.operand)) ||
        expression.branches.some(
          ({ when, then }) => this.#containsTopLevelAggregate(when) || this.#containsTopLevelAggregate(then),
        ) ||
        (expression.elseExpression !== undefined && this.#containsTopLevelAggregate(expression.elseExpression))
      );
    if (expression.kind === "in")
      return (
        this.#containsTopLevelAggregate(expression.expression) ||
        (!("kind" in expression.values) && expression.values.some((value) => this.#containsTopLevelAggregate(value)))
      );
    if (expression.kind === "between")
      return (
        this.#containsTopLevelAggregate(expression.expression) ||
        this.#containsTopLevelAggregate(expression.lower) ||
        this.#containsTopLevelAggregate(expression.upper)
      );
    return false;
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
        this.#unsupported("SQLite CTE bodies must be SELECT statements", query.statement.range);
      }
      const recursive = query.statement.kind === "select" && this.#isRecursiveCte(query);
      const result =
        query.statement.kind === "select"
          ? recursive
            ? this.#recursiveCte(query as CommonTableExpression & { readonly statement: SelectStatement }, outer, ctes)
            : {
                columns: this.#select(query.statement, outer, ctes, query.columns.length === 0),
                resultKind: "rows" as const,
              }
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

  #isRecursiveCte(query: CommonTableExpression): boolean {
    if (query.statement.kind !== "select") return false;
    return this.#selectArms(query.statement).some(({ statement }) => this.#selfReferences(statement, query.name) > 0);
  }

  #recursiveCte(
    query: CommonTableExpression & { readonly statement: SelectStatement },
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedSqliteColumn[]; readonly resultKind: "rows" } {
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
    if (firstRecursive <= 0)
      invalid(
        `Recursive CTE ${query.name.name} requires a non-recursive SELECT before its recursive member`,
        query.range,
      );

    let recursiveAll: boolean | undefined;
    for (let index = 0; index < arms.length; index += 1) {
      const arm = arms[index]!;
      const reference = references[index]!;
      if (reference.total === 0) {
        if (firstRecursive >= 0 && index > firstRecursive)
          invalid(`Non-recursive members of ${query.name.name} must precede recursive members`, arm.statement.range);
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
      } else if (recursiveAll === undefined) recursiveAll = arm.all ?? false;
      else if ((arm.all ?? false) !== recursiveAll) {
        invalid(`All recursive members of ${query.name.name} must use the same UNION form`, arm.range);
      }
      if (this.#hasAggregateOrWindow(arm.statement)) {
        this.#diagnostic(
          "TSQ221",
          `Recursive member of ${query.name.name} cannot use aggregate or window functions`,
          arm.statement.range,
        );
        valid = false;
      }
    }

    const seedColumns = this.#mergeCteSeedColumns(
      arms.slice(0, Math.max(firstRecursive, 0)).map(({ statement }) => statement),
      outer,
      inherited,
    );
    const provisionalColumns: Record<string, ColumnSnapshot> = {};
    const width = Math.max(query.columns.length, seedColumns.length);
    for (let index = 0; index < width; index += 1) {
      const seed = seedColumns[index];
      const columnName = query.columns[index] === undefined ? seed?.name : name(query.columns[index]!);
      if (columnName === undefined) continue;
      provisionalColumns[columnName] = {
        name: columnName,
        databaseType: seed?.databaseType ?? "unknown",
        tsType: seed?.tsType ?? "unknown",
        nullable: seed?.nullable ?? true,
      };
    }
    const recursiveScope = new Map(inherited);
    recursiveScope.set(name(query.name), { name: name(query.name), columns: provisionalColumns });
    const columns = this.#select(query.statement, outer, recursiveScope, query.columns.length === 0);
    if (!valid && columns.length === 0) {
      return {
        columns: Object.values(provisionalColumns).map((column) => ({
          name: column.name,
          tsType: "unknown",
          nullable: true,
          databaseType: "unknown",
          range: query.range,
        })),
        resultKind: "rows",
      };
    }
    return { columns, resultKind: "rows" };
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
      if (first !== undefined)
        arms.push({
          statement: first.statement,
          operator: compound.operator,
          all: compound.all,
          range: compound.range,
        });
      arms.push(...rest);
    }
    return arms;
  }

  #directSelfReferences(statement: SelectStatement, identifier: Identifier): number {
    const references = [statement.from, ...statement.joins.map(({ table }) => table)];
    return references.filter(
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

  #hasAggregateOrWindow(statement: SelectStatement): boolean {
    let prohibited = statement.windows.length > 0;
    walkStatement(statement, {
      expression(expression) {
        if (
          expression.kind === "call" &&
          (expression.over !== undefined ||
            expression.filter !== undefined ||
            isSqliteAggregateFunction(expression.name.name))
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
  ): readonly ResolvedSqliteColumn[] {
    const merged: ResolvedSqliteColumn[] = [];
    for (const statement of statements) {
      const probe = new Resolver(this.#schema, { typePolicy: this.#policy, strictExpressions: false });
      const columns = probe.#select(statement, outer, inherited, false);
      if (merged.length === 0) {
        merged.push(...columns);
        continue;
      }
      for (let index = 0; index < Math.min(merged.length, columns.length); index += 1) {
        const current = merged[index]!;
        const candidate = columns[index]!;
        const sameDatabaseType = current.databaseType === candidate.databaseType && current.databaseType !== undefined;
        merged[index] = {
          name: current.name,
          tsType: unionSqliteTypes([current.tsType, candidate.tsType]),
          nullable: current.nullable || candidate.nullable,
          ...(sameDatabaseType ? { databaseType: current.databaseType } : {}),
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
    requireOutputNames = true,
  ): readonly ResolvedSqliteColumn[] {
    const previousWindows = this.#activeWindows;
    this.#activeWindows = this.#windows(statement);
    const scope: Scope = { relations: [], usingColumns: new Map(), ...(outer === undefined ? {} : { outer }) };
    if (statement.distinctOn.length > 0)
      this.#unsupported("SQLite does not support DISTINCT ON", statement.distinctOn[0]!.range);
    const prohibitedWindowExpressions = [
      statement.where,
      statement.having,
      ...statement.groupBy,
      ...statement.joins.map(({ on }) => on),
      ...statement.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...specification.orderBy.map(({ expression }) => expression),
      ]),
    ].filter((expression): expression is Expression => expression !== undefined);
    for (const expression of prohibitedWindowExpressions) {
      if (containsWindowFunction(expression))
        this.#diagnostic(
          "TSQ223",
          "Window functions are only allowed in SELECT results and ORDER BY",
          expression.range,
        );
    }
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
      this.#windowFrame(window.specification, scope, ctes);
    }
    const columns = [...this.#items(statement.columns, scope, ctes, requireOutputNames)];
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
      const right = this.#select(compound.statement, outer, ctes, false);
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
          tsType: unionSqliteTypes([left.tsType, candidate.tsType]),
          nullable: left.nullable || candidate.nullable,
          ...(left.databaseType === candidate.databaseType && left.databaseType !== undefined
            ? { databaseType: left.databaseType }
            : {}),
        };
      }
    }
    this.#activeWindows = previousWindows;
    return columns;
  }

  #windows(statement: SelectStatement): ReadonlyMap<string, WindowSpecification> {
    const windows = new Map<string, WindowSpecification>();
    for (const window of statement.windows) {
      const key = name(window.name);
      if (windows.has(key)) {
        this.#diagnostic("TSQ222", `Duplicate window ${window.name.name}`, window.name.range);
        continue;
      }
      const specification = this.#effectiveWindow(window.specification, windows);
      windows.set(key, specification);
    }
    return windows;
  }

  #effectiveWindow(
    specification: WindowSpecification,
    windows: ReadonlyMap<string, WindowSpecification> = this.#activeWindows,
  ): WindowSpecification {
    if (specification.base === undefined) {
      this.#validateWindowFrame(specification);
      return specification;
    }
    const base = windows.get(name(specification.base));
    if (base === undefined) {
      this.#diagnostic("TSQ222", `Unknown base window ${specification.base.name}`, specification.base.range);
      return specification;
    }
    if (specification.partitionBy.length > 0)
      this.#diagnostic("TSQ222", "A chained window cannot replace PARTITION BY", specification.range);
    if (base.orderBy.length > 0 && specification.orderBy.length > 0)
      this.#diagnostic("TSQ222", "A chained window cannot replace ORDER BY", specification.range);
    if (base.frame !== undefined)
      this.#diagnostic("TSQ222", "A framed window cannot be used as a chaining base", specification.base.range);
    const effective: WindowSpecification = {
      ...specification,
      partitionBy: base.partitionBy,
      orderBy: base.orderBy.length > 0 ? base.orderBy : specification.orderBy,
    };
    this.#validateWindowFrame(effective);
    return effective;
  }

  #validateWindowFrame(specification: WindowSpecification): void {
    const frame = specification.frame;
    if (frame?.unit !== "range") return;
    const hasOffset = [frame.start, frame.end].some(({ kind }) => kind === "preceding" || kind === "following");
    if (hasOffset && specification.orderBy.length !== 1) {
      this.#diagnostic("TSQ222", "A RANGE offset frame requires exactly one ORDER BY expression", frame.range);
    }
  }

  #windowFrame(specification: WindowSpecification, scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const frame = specification.frame;
    if (frame === undefined) return;
    for (const boundary of [frame.start, frame.end]) {
      if (boundary.kind === "preceding" || boundary.kind === "following") {
        if (!isConstantFrameExpression(boundary.expression))
          this.#diagnostic("TSQ222", "A window-frame offset must be a constant numeric expression", boundary.range);
        if (
          (frame.unit === "rows" || frame.unit === "groups") &&
          boundary.expression.kind === "literal" &&
          (typeof boundary.expression.value !== "number" ||
            !Number.isInteger(boundary.expression.value) ||
            boundary.expression.value < 0)
        ) {
          this.#diagnostic(
            "TSQ222",
            `${frame.unit.toUpperCase()} offsets must be non-negative integers`,
            boundary.range,
          );
        }
        this.#expression(boundary.expression, scope, ctes, this.#databaseType("numeric", false));
      }
    }
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
        tsType: unionSqliteTypes([left.tsType, rightType.tsType]),
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
    if (reference.kind === "table-function") {
      if (reference.lateral) this.#unsupported("SQLite does not support the LATERAL keyword", reference.range);
      for (const argument of reference.arguments) this.#expression(argument, scope, ctes);
      const functionName = reference.name.name.toUpperCase();
      const definition = [...SQLITE_JSON_TABLE_FUNCTIONS, ...SQLITE_EXTENSION_TABLE_FUNCTIONS].find(
        ({ name }) => name === functionName,
      );
      if (definition === undefined) {
        this.#diagnostic("TSQ100", `Unknown table-valued function ${reference.name.name}`, reference.name.range);
        return undefined;
      }
      if (
        reference.arguments.length < definition.arguments[0] ||
        reference.arguments.length > definition.arguments[1]
      ) {
        this.#diagnostic(
          "TSQ227",
          `${reference.name.name} expects ${this.#arity(definition.arguments)} arguments, received ${reference.arguments.length}`,
          reference.range,
        );
      }
      if (!this.#tableFunctionAvailable(definition, reference.range)) return undefined;
      if (definition.result === "carray") {
        if (reference.arguments[1]?.kind === "parameter")
          this.#expression(reference.arguments[1], scope, ctes, this.#databaseType("integer", false));
        if (reference.arguments[2]?.kind === "parameter")
          this.#expression(reference.arguments[2], scope, ctes, this.#databaseType("text", false));
      } else {
        const jsonInput = {
          tsType: sqliteFlexibleType(this.#policy),
          nullable: true,
          databaseType: "json",
        };
        const rootPath = { tsType: "string", nullable: true, databaseType: "text" };
        if (reference.arguments[0]?.kind === "parameter")
          this.#expression(reference.arguments[0], scope, ctes, jsonInput);
        if (reference.arguments[1]?.kind === "parameter")
          this.#expression(reference.arguments[1], scope, ctes, rootPath);
      }
      const flexible = sqliteFlexibleType(this.#policy);
      table =
        definition.result === "carray"
          ? {
              name: name(reference.alias ?? reference.name),
              columns: {
                value: { name: "value", databaseType: "ANY", tsType: flexible, nullable: true },
              },
            }
          : ({
              name: name(reference.alias ?? reference.name),
              columns: {
                key: {
                  name: "key",
                  databaseType: "ANY",
                  tsType: unionSqliteTypes([this.#policy.integer, "string"]),
                  nullable: true,
                },
                value: {
                  name: "value",
                  databaseType: "ANY",
                  tsType:
                    definition.result === "jsonb"
                      ? unionSqliteTypes([this.#policy.integer, "number", "string", "Uint8Array"])
                      : unionSqliteTypes([this.#policy.integer, "number", "string"]),
                  nullable: true,
                },
                type: { name: "type", databaseType: "TEXT", tsType: "string", nullable: false },
                atom: {
                  name: "atom",
                  databaseType: "ANY",
                  tsType: unionSqliteTypes([this.#policy.integer, "number", "string"]),
                  nullable: true,
                },
                id: { name: "id", databaseType: "INTEGER", tsType: this.#policy.integer, nullable: false },
                parent: { name: "parent", databaseType: "INTEGER", tsType: this.#policy.integer, nullable: true },
                fullkey: { name: "fullkey", databaseType: "TEXT", tsType: "string", nullable: false },
                path: { name: "path", databaseType: "TEXT", tsType: "string", nullable: false },
                json: { name: "json", databaseType: "JSON", tsType: "string", nullable: true, hidden: true },
                root: { name: "root", databaseType: "TEXT", tsType: "string", nullable: true, hidden: true },
              },
            } as TableSnapshot);
      alias = name(reference.alias ?? reference.name);
    } else if (reference.kind === "subquery") {
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
    requireOutputNames = true,
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
            if ("hidden" in column && column.hidden === true) continue;
            add({ name: column.name, ...this.#columnType(relation, column), range: item.range });
          }
        continue;
      }
      const type = this.#expression(item.expression, scope, ctes);
      const output = item.alias === undefined ? this.#outputName(item.expression) : name(item.alias);
      if (output === undefined) {
        if (this.#strict && requireOutputNames)
          this.#diagnostic("TSQ104", "Expressions in SELECT require an explicit alias", item.range, "Add AS <name>.");
        if (requireOutputNames) continue;
      }
      add({ name: output ?? `column${columns.length + 1}`, ...type, range: item.range });
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
      if (
        expression.relation === undefined &&
        !expression.column.quoted &&
        SQLITE_CURRENT_TIME_KEYWORDS.has(expression.column.name.toUpperCase())
      )
        return { tsType: "string", nullable: false, databaseType: "text" };
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
        databaseType: normalizeSqliteDatabaseType(expression.databaseType.name),
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
        tsType: unionSqliteTypes(values.map((value) => value.tsType)),
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
      if (!("kind" in expression.values))
        nullable ||= expression.values
          .map((value) => this.#expression(value, scope, ctes, subject))
          .some((value) => value.nullable);
      else if (expression.values.kind !== "select") {
        const tableScope: Scope = { relations: [], usingColumns: new Map(), outer: scope };
        const relation = this.#relation(expression.values, false, tableScope, ctes);
        const columns = Object.values(relation?.table.columns ?? {}).filter(
          (column) => !("hidden" in column && column.hidden === true),
        );
        if (columns.length !== 1)
          this.#diagnostic(
            "TSQ217",
            `IN table expression returns ${columns.length} columns instead of one`,
            expression.range,
          );
        const column = columns[0];
        if (column !== undefined && expression.expression.kind === "parameter")
          this.#expression(expression.expression, scope, ctes, this.#snapshotType(column));
        nullable ||= column?.nullable ?? true;
      } else {
        const result = this.#statement(expression.values, scope, ctes);
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
    if (SQLITE_UNSUPPORTED_OPERATORS.has(expression.operator)) {
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
    const operator = sqliteOperator(expression.operator);
    if (operator?.result === "json-text" || operator?.result === "json-flexible") {
      const availability = resolveSqliteBuiltin(
        "JSON",
        1,
        this.#schema.server?.versionKey ?? this.#schema.version,
        this.#schema.server?.features,
      );
      if (!this.#catalogAvailable(availability, `operator ${expression.operator}`, expression.range))
        return { tsType: "unknown", nullable: true };
    }
    if (operator?.result === "comparison")
      return {
        tsType: this.#policy.integer,
        nullable: operator.nullSafe === true ? false : left.nullable || right.nullable,
        databaseType: "integer",
      };
    if (operator?.result === "text") {
      return { tsType: "string", nullable: left.nullable || right.nullable, databaseType: "text" };
    }
    if (operator?.result === "json-text") return { tsType: "string", nullable: true, databaseType: "text" };
    if (operator?.result === "json-flexible")
      return {
        tsType: sqliteFlexibleType(this.#policy),
        nullable: true,
      };
    if (operator?.result === "numeric" && sqliteNumericOperands(left.databaseType, right.databaseType)) {
      return {
        tsType: unionSqliteTypes([this.#policy.integer, "number"]),
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
      const window = this.#effectiveWindow(expression.over);
      for (const value of window.partitionBy) this.#expression(value, scope, ctes);
      for (const item of window.orderBy) this.#expression(item.expression, scope, ctes);
      this.#windowFrame(window, scope, ctes);
    } else if (expression.over !== undefined && !this.#activeWindows.has(name(expression.over))) {
      this.#diagnostic("TSQ222", `Unknown window ${expression.over.name}`, expression.over.range);
    }
    const functionName = expression.name.name.toUpperCase();
    const routineCandidates = this.#index.routineOverloads(
      name(expression.name),
      values.length,
      expression.schema === undefined ? undefined : name(expression.schema),
    );
    if (routineCandidates.length > 0) {
      if (routineCandidates.length > 1) {
        this.#diagnostic("TSQ204", `Ambiguous function ${expression.name.name}`, expression.range);
        return { tsType: "unknown", nullable: true };
      }
      return this.#applicationRoutine(expression, routineCandidates[0]!, values, scope, ctes);
    }
    const declaredCandidates = this.#index.functions(
      name(expression.name),
      values.length,
      expression.schema === undefined ? undefined : name(expression.schema),
    );
    if (declaredCandidates.length > 0) {
      if (declaredCandidates.length > 1) {
        this.#diagnostic("TSQ204", `Ambiguous function ${expression.name.name}`, expression.range);
        return { tsType: "unknown", nullable: true };
      }
      if (expression.over !== undefined || expression.filter !== undefined)
        this.#diagnostic(
          "TSQ227",
          `Legacy function ${expression.name.name} has no aggregate or window kind evidence`,
          expression.range,
        );
      const selected = declaredCandidates[0]!;
      expression.arguments.forEach((argument, index) => {
        if (argument.kind === "parameter")
          this.#expression(argument, scope, ctes, this.#databaseType(selected.argumentTypes[index]!, true));
      });
      return this.#function(selected);
    }
    const builtinWindow = isSqliteWindowFunction(functionName);
    if (builtinWindow && expression.over === undefined)
      this.#diagnostic("TSQ223", `${expression.name.name} requires an OVER clause`, expression.range);
    if (expression.over !== undefined && (expression.distinct || (builtinWindow && expression.filter !== undefined))) {
      this.#diagnostic(
        "TSQ223",
        expression.distinct
          ? "SQLite window functions cannot use DISTINCT"
          : `SQLite built-in window function ${expression.name.name} cannot use FILTER`,
        expression.range,
      );
    }
    const builtin = resolveSqliteBuiltin(
      functionName,
      values.length,
      this.#schema.server?.versionKey ?? this.#schema.version,
      this.#schema.server?.features,
    );
    if (builtin.status === "exact") {
      if (expression.over !== undefined && builtin.definition.kind === "scalar")
        this.#diagnostic("TSQ223", `${expression.name.name} is not a window or aggregate function`, expression.range);
      if (expression.filter !== undefined && builtin.definition.kind === "scalar")
        this.#diagnostic("TSQ227", `${expression.name.name} cannot use FILTER`, expression.range);
      if (builtin.definition.result === "coalesce" || builtin.definition.result === "nullif") {
        const firstArgument = expression.arguments[0];
        const secondArgument = expression.arguments[1];
        if (firstArgument?.kind === "parameter" && values[1] !== undefined) {
          this.#expression(firstArgument, scope, ctes, values[1]);
        }
        if (secondArgument?.kind === "parameter" && values[0] !== undefined) {
          this.#expression(secondArgument, scope, ctes, values[0]);
        }
      }
      this.#builtinParameters(functionName, expression, scope, ctes);
      this.#dateTimeArguments(functionName, expression);
      return this.#builtinResult(builtin.definition, values, expression.arguments);
    }
    if (builtin.status === "arity") {
      const ranges = [...new Set(builtin.definitions.map(({ arguments: range }) => this.#arity(range)))].join(" or ");
      this.#diagnostic(
        builtinWindow ? "TSQ223" : "TSQ227",
        `${expression.name.name} expects ${ranges} arguments, received ${values.length}`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    if (builtin.status === "evidence-required") {
      this.#diagnostic(
        "TSQ402",
        `SQLite ${builtin.since} server-version evidence is required to resolve ${expression.name.name}`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    if (builtin.status === "outside-supported-version") {
      this.#diagnostic(
        "TSQ403",
        `SQLite ${builtin.status === "outside-supported-version" ? builtin.version : "version"} is outside the tested built-in catalog range`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    if (builtin.status === "unavailable") {
      this.#diagnostic("TSQ404", `${expression.name.name} requires SQLite ${builtin.since} or newer`, expression.range);
      return { tsType: "unknown", nullable: true };
    }
    if (builtin.status === "compile-evidence-required") {
      this.#diagnostic(
        "TSQ402",
        `SQLite compile-option evidence is required to resolve ${expression.name.name} (${builtin.option})`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    if (builtin.status === "compile-option-unavailable") {
      this.#diagnostic(
        "TSQ406",
        `${expression.name.name} is unavailable under the recorded SQLite compile options (${builtin.option})`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    this.#diagnostic("TSQ202", `Unknown function ${expression.name.name}`, expression.range, undefined, "warning");
    return { tsType: "unknown", nullable: true };
  }

  #applicationRoutine(
    expression: CallExpression,
    routine: StructuralRoutineSnapshot,
    _values: readonly ResolvedType[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
    const inputs = routine.arguments.filter(({ mode }) => mode !== "out");
    expression.arguments.forEach((argument, index) => {
      const expected = inputs[index];
      if (argument.kind === "parameter" && expected !== undefined)
        this.#expression(argument, scope, ctes, {
          tsType: expected.tsType,
          nullable: true,
          databaseType: expected.databaseType,
        });
    });
    if (routine.kind === "window" && expression.over === undefined)
      this.#diagnostic("TSQ223", `${expression.name.name} requires an OVER clause`, expression.range);
    if (routine.kind === "function" && expression.over !== undefined)
      this.#diagnostic("TSQ223", `${expression.name.name} is not a window or aggregate function`, expression.range);
    if (routine.kind === "function" && expression.filter !== undefined)
      this.#diagnostic("TSQ227", `${expression.name.name} cannot use FILTER`, expression.range);
    if (routine.kind === "window" && expression.distinct)
      this.#diagnostic("TSQ223", "SQLite window functions cannot use DISTINCT", expression.range);
    const result = routine.result;
    if (result.kind === "scalar")
      return { tsType: result.tsType, nullable: result.nullable, databaseType: result.databaseType };
    this.#diagnostic("TSQ227", `${expression.name.name} does not have a scalar SQL result`, expression.range);
    return { tsType: "unknown", nullable: true };
  }

  #catalogAvailable(resolution: SqliteBuiltinResolution, displayName: string, range: SourceRange): boolean {
    if (resolution.status === "exact") return true;
    if (resolution.status === "evidence-required")
      this.#diagnostic(
        "TSQ402",
        `SQLite ${resolution.since} server-version evidence is required to resolve ${displayName}`,
        range,
      );
    else if (resolution.status === "outside-supported-version")
      this.#diagnostic("TSQ403", `SQLite ${resolution.version} is outside the tested built-in catalog range`, range);
    else if (resolution.status === "unavailable")
      this.#diagnostic("TSQ404", `${displayName} requires SQLite ${resolution.since} or newer`, range);
    else if (resolution.status === "compile-evidence-required")
      this.#diagnostic(
        "TSQ402",
        `SQLite compile-option evidence is required to resolve ${displayName} (${resolution.option})`,
        range,
      );
    else if (resolution.status === "compile-option-unavailable")
      this.#diagnostic(
        "TSQ406",
        `${displayName} is unavailable under the recorded SQLite compile options (${resolution.option})`,
        range,
      );
    else
      this.#diagnostic(
        resolution.status === "arity" ? "TSQ227" : "TSQ202",
        resolution.status === "arity" ? `Invalid invocation of ${displayName}` : `Unknown function ${displayName}`,
        range,
      );
    return false;
  }

  #tableFunctionAvailable(definition: SqliteTableFunctionDefinition, range: SourceRange): boolean {
    const version = this.#schema.server?.versionKey ?? this.#schema.version;
    const parsed = version === undefined ? undefined : parseSqliteVersion(version);
    if (parsed === undefined) {
      this.#diagnostic(
        "TSQ402",
        `SQLite ${definition.availableSince} server-version evidence is required to resolve ${definition.name}`,
        range,
      );
      return false;
    }
    const support = sqliteVersionSupport(version!);
    if (support === "below-supported" || support === "newer-than-tested" || support === "prerelease") {
      this.#diagnostic("TSQ403", `SQLite ${version} is outside the tested table-function catalog range`, range);
      return false;
    }
    if (compareSqliteVersions(parsed, parseSqliteVersion(definition.availableSince)!) < 0) {
      this.#diagnostic("TSQ404", `${definition.name} requires SQLite ${definition.availableSince} or newer`, range);
      return false;
    }
    const option = definition.requiredCompileOption ?? definition.omittedByCompileOption;
    const features = this.#schema.server?.features;
    if (features === undefined) {
      this.#diagnostic(
        "TSQ402",
        `SQLite compile-option evidence is required to resolve ${definition.name} (${option})`,
        range,
      );
      return false;
    }
    const has = (candidate: string): boolean =>
      features.some((feature) => feature === candidate || feature.startsWith(`${candidate}=`));
    if (
      (definition.requiredCompileOption !== undefined && !has(definition.requiredCompileOption)) ||
      (definition.omittedByCompileOption !== undefined && has(definition.omittedByCompileOption))
    ) {
      this.#diagnostic(
        "TSQ406",
        `${definition.name} is unavailable under the recorded SQLite compile options (${option})`,
        range,
      );
      return false;
    }
    return true;
  }

  #dateTimeArguments(functionName: string, expression: CallExpression): void {
    if (!["DATE", "DATETIME", "JULIANDAY", "STRFTIME", "TIME", "UNIXEPOCH"].includes(functionName)) return;
    const modifierStart = functionName === "STRFTIME" ? 2 : 1;
    const argumentsToCheck = [...expression.arguments.slice(modifierStart)];
    const first = expression.arguments[0];
    if (
      first?.kind === "literal" &&
      typeof first.value === "string" &&
      ["subsec", "subsecond"].includes(first.value.toLowerCase())
    )
      argumentsToCheck.push(first);
    for (const argument of argumentsToCheck) {
      if (argument.kind !== "literal" || typeof argument.value !== "string") continue;
      const modifier = argument.value.toLowerCase();
      if (modifier === "subsec" || modifier === "subsecond")
        this.#dateTimeVersion("3.42.0", `date/time modifier ${argument.value}`, argument.range);
      if (modifier === "ceiling" || modifier === "floor")
        this.#dateTimeVersion("3.46.0", `date/time modifier ${argument.value}`, argument.range);
    }
    if (functionName === "STRFTIME") {
      const format = expression.arguments[0];
      if (format?.kind === "literal" && typeof format.value === "string" && /%(?:G|g|U|V)/u.test(format.value))
        this.#dateTimeVersion("3.46.0", "the requested strftime substitution", format.range);
    }
  }

  #builtinParameters(
    functionName: string,
    expression: CallExpression,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): void {
    const numeric = {
      tsType: unionSqliteTypes([this.#policy.integer, "number"]),
      nullable: true,
      databaseType: "numeric",
    };
    const text = { tsType: "string", nullable: true, databaseType: "text" };
    const json = { tsType: sqliteFlexibleType(this.#policy), nullable: true, databaseType: "json" };
    const jsonValue = { tsType: sqliteFlexibleType(this.#policy), nullable: true };
    const timeValue = {
      tsType: unionSqliteTypes([this.#policy.integer, "number", "string"]),
      nullable: true,
      databaseType: "numeric",
    };
    const expect = (index: number, expected: ResolvedType): void => {
      const argument = expression.arguments[index];
      if (argument?.kind === "parameter") this.#expression(argument, scope, ctes, expected);
    };
    if (
      SQLITE_MATH_FUNCTIONS.some(({ name }) => name === functionName) ||
      ["MEDIAN", "PERCENTILE", "PERCENTILE_CONT", "PERCENTILE_DISC"].includes(functionName)
    ) {
      expression.arguments.forEach((_, index) => {
        expect(index, numeric);
      });
      return;
    }
    if (functionName === "SOUNDEX") {
      expect(0, text);
      return;
    }
    if (["DATE", "DATETIME", "JULIANDAY", "TIME", "UNIXEPOCH"].includes(functionName)) {
      expect(0, timeValue);
      for (let index = 1; index < expression.arguments.length; index += 1) expect(index, text);
      return;
    }
    if (functionName === "STRFTIME") {
      expect(0, text);
      expect(1, timeValue);
      for (let index = 2; index < expression.arguments.length; index += 1) expect(index, text);
      return;
    }
    if (functionName === "TIMEDIFF") {
      expect(0, timeValue);
      expect(1, timeValue);
      return;
    }
    if (!functionName.startsWith("JSON")) return;
    if (["JSON_ARRAY", "JSONB_ARRAY"].includes(functionName)) {
      expression.arguments.forEach((_, index) => {
        expect(index, jsonValue);
      });
      return;
    }
    if (["JSON_GROUP_ARRAY", "JSONB_GROUP_ARRAY", "JSON_QUOTE"].includes(functionName)) {
      expect(0, jsonValue);
      return;
    }
    if (["JSON_OBJECT", "JSONB_OBJECT"].includes(functionName)) {
      for (let index = 0; index < expression.arguments.length; index += 2) {
        expect(index, text);
        expect(index + 1, jsonValue);
      }
      return;
    }
    if (["JSON_GROUP_OBJECT", "JSONB_GROUP_OBJECT"].includes(functionName)) {
      expect(0, text);
      return;
    }
    expect(0, json);
    if (
      ["JSON_ARRAY_LENGTH", "JSON_EXTRACT", "JSONB_EXTRACT", "JSON_REMOVE", "JSONB_REMOVE", "JSON_TYPE"].includes(
        functionName,
      )
    ) {
      for (let index = 1; index < expression.arguments.length; index += 1) expect(index, text);
      return;
    }
    if (
      [
        "JSON_ARRAY_INSERT",
        "JSON_INSERT",
        "JSON_REPLACE",
        "JSON_SET",
        "JSONB_ARRAY_INSERT",
        "JSONB_INSERT",
        "JSONB_REPLACE",
        "JSONB_SET",
      ].includes(functionName)
    ) {
      for (let index = 1; index < expression.arguments.length; index += 2) expect(index, text);
      for (let index = 2; index < expression.arguments.length; index += 2) expect(index, jsonValue);
      return;
    }
    if (functionName === "JSON_VALID") expect(1, numeric);
    if (functionName === "JSON_PRETTY") expect(1, text);
  }

  #dateTimeVersion(minimum: string, feature: string, range: SourceRange): void {
    const version = this.#schema.server?.versionKey ?? this.#schema.version;
    if (version === undefined || parseSqliteVersion(version) === undefined) {
      this.#diagnostic("TSQ402", `SQLite ${minimum} server-version evidence is required for ${feature}`, range);
      return;
    }
    if (compareSqliteVersions(parseSqliteVersion(version)!, parseSqliteVersion(minimum)!) < 0)
      this.#diagnostic("TSQ404", `${feature} requires SQLite ${minimum} or newer`, range);
  }

  #arity(range: readonly [number, number]): string {
    if (range[0] === range[1]) return String(range[0]);
    if (!Number.isFinite(range[1])) return `at least ${range[0]}`;
    return `${range[0]} to ${range[1]}`;
  }

  #builtinResult(
    definition: SqliteBuiltinDefinition,
    values: readonly ResolvedType[],
    arguments_: readonly Expression[],
  ): ResolvedType {
    const first = values[0] ?? { tsType: "unknown", nullable: true };
    switch (definition.result) {
      case "blob":
        return { tsType: "Uint8Array", nullable: false, databaseType: "blob" };
      case "blob-nullable":
        return { tsType: "Uint8Array", nullable: true, databaseType: "blob" };
      case "coalesce":
        return {
          tsType: unionSqliteTypes(values.map((value) => value.tsType)),
          nullable: values.every((value) => value.nullable),
        };
      case "concat":
        return { tsType: "string", nullable: false, databaseType: "text" };
      case "concat-ws":
        return { tsType: "string", nullable: first.nullable, databaseType: "text" };
      case "first-argument":
        return first;
      case "first-argument-nullable":
        return { ...first, nullable: true };
      case "flexible-nullable":
        return {
          tsType: unionSqliteTypes(values.map((value) => value.tsType)),
          nullable: values.some((value) => value.nullable),
        };
      case "iif": {
        const branches = values.filter(
          (_, index) => index % 2 === 1 || (values.length % 2 === 1 && index === values.length - 1),
        );
        return {
          tsType: unionSqliteTypes(branches.map((value) => value.tsType)),
          nullable: values.length % 2 === 0 || branches.some((value) => value.nullable),
        };
      }
      case "integer":
        return { tsType: this.#policy.integer, nullable: false, databaseType: "integer" };
      case "integer-always-nullable":
        return { tsType: this.#policy.integer, nullable: true, databaseType: "integer" };
      case "integer-nullable":
        return {
          tsType: this.#policy.integer,
          nullable: values.some((value) => value.nullable),
          databaseType: "integer",
        };
      case "json-extract":
        return values.length === 2
          ? { tsType: sqliteFlexibleType(this.#policy), nullable: true }
          : { tsType: "string", nullable: true, databaseType: "text" };
      case "jsonb-extract":
        return values.length === 2
          ? { tsType: sqliteFlexibleType(this.#policy), nullable: true }
          : { tsType: "Uint8Array", nullable: true, databaseType: "blob" };
      case "lag-lead": {
        const fallback = values[2];
        return {
          ...first,
          tsType: fallback === undefined ? first.tsType : unionSqliteTypes([first.tsType, fallback.tsType]),
          nullable: first.nullable || fallback === undefined || fallback.nullable,
        };
      }
      case "nullif":
        return { ...first, nullable: true };
      case "numeric-from-arguments":
        return {
          tsType: unionSqliteTypes([this.#policy.integer, "number"]),
          nullable: values.some((value) => value.nullable),
          databaseType: "numeric",
        };
      case "numeric-nullable":
        return {
          tsType: unionSqliteTypes([this.#policy.integer, "number"]),
          nullable: true,
          databaseType: "numeric",
        };
      case "real":
        return { tsType: "number", nullable: false, databaseType: "real" };
      case "real-nullable":
        return { tsType: "number", nullable: true, databaseType: "real" };
      case "text":
        return { tsType: "string", nullable: false, databaseType: "text" };
      case "text-always-nullable":
        return { tsType: "string", nullable: true, databaseType: "text" };
      case "text-nullable":
        return { tsType: "string", nullable: values.some((value) => value.nullable), databaseType: "text" };
      case "unixepoch": {
        const dynamic = arguments_.some(
          (argument) => argument.kind !== "literal" || typeof argument.value !== "string",
        );
        const subsecond = arguments_.some(
          (argument) =>
            argument.kind === "literal" &&
            typeof argument.value === "string" &&
            ["subsec", "subsecond"].includes(argument.value.toLowerCase()),
        );
        return {
          tsType: subsecond
            ? "number"
            : dynamic
              ? unionSqliteTypes([this.#policy.integer, "number"])
              : this.#policy.integer,
          nullable: true,
          databaseType: subsecond ? "real" : dynamic ? "numeric" : "integer",
        };
      }
      case "unknown-nullable":
        return { tsType: "unknown", nullable: true };
    }
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
    const matches = relations.flatMap((relation): readonly [Relation, ResolvedType][] => {
      const column = this.#column(relation.table, columnName);
      if (column !== undefined) return [[relation, this.#columnType(relation, column)]];
      return this.#hasImplicitRowid(relation.table, columnName)
        ? [[relation, { tsType: this.#policy.integer, nullable: relation.nullable, databaseType: "integer" }]]
        : [];
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
    return matches[0]![1];
  }

  #column(table: TableSnapshot, columnName: string): ColumnSnapshot | undefined {
    return this.#index.column(table, columnName);
  }

  #findColumn(table: TableSnapshot | undefined, identifier: Identifier): ColumnSnapshot | undefined {
    const column =
      table === undefined
        ? undefined
        : (this.#column(table, name(identifier)) ??
          (this.#hasImplicitRowid(table, name(identifier))
            ? {
                name: identifier.name,
                databaseType: "INTEGER",
                tsType: this.#policy.integer,
                nullable: false,
              }
            : undefined));
    if (column === undefined) this.#diagnostic("TSQ101", `Unknown column ${identifier.name}`, identifier.range);
    return column;
  }

  #columnType(relation: Relation, column: ColumnSnapshot): ResolvedType {
    return { tsType: column.tsType, nullable: column.nullable || relation.nullable, databaseType: column.databaseType };
  }

  #hasImplicitRowid(table: TableSnapshot, columnName: string): boolean {
    if (!["rowid", "oid", "_rowid_"].includes(columnName.toLowerCase())) return false;
    if (this.#column(table, columnName) !== undefined) return false;
    const sqliteTable = table as TableSnapshot & {
      readonly kind?: "shadow" | "table" | "view" | "virtual";
      readonly withoutRowid?: boolean;
    };
    return sqliteTable.withoutRowid !== true && (sqliteTable.kind === "table" || sqliteTable.kind === "shadow");
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

  #insertable(table: TableSnapshot, column: ColumnSnapshot): boolean {
    const evidence = this.#index.columnEligibility(table, column, "insert");
    return evidence === "unknown" ? !this.#generated(column) && !this.#hidden(column) : evidence;
  }

  #updatable(table: TableSnapshot, column: ColumnSnapshot): boolean {
    const evidence = this.#index.columnEligibility(table, column, "update");
    return evidence === "unknown" ? !this.#generated(column) && !this.#hidden(column) : evidence;
  }

  #hidden(column: ColumnSnapshot): boolean {
    return "hidden" in column && column.hidden === true;
  }

  #databaseType(databaseType: string, nullable: boolean): ResolvedType {
    return {
      tsType: mapSqliteCastType(databaseType, this.#policy),
      nullable,
      databaseType: normalizeSqliteDatabaseType(databaseType),
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
