import {
  closestName,
  ParameterCollector,
  type ResolvedParameter,
  ResolverSchemaIndex,
  type StructuralRoutineSnapshot,
  unionTypeLiterals,
} from "@typed-sql/core";
import type { ColumnSnapshot, FunctionSnapshot, SchemaSnapshot, TableSnapshot } from "@typed-sql/schema";
import {
  postgresCatalogRoutineRule,
  postgresCatalogTableRoutineRule,
  postgresCatalogTypeMapping,
} from "./catalog/index.js";
import { fingerprintPostgresExpression, postgresExpressionIdentity } from "./expression-evidence.js";
import type {
  CallExpression,
  CommonTableExpression,
  Expression,
  FunctionTableReference,
  GroupingElement,
  Identifier,
  InsertConflictTarget,
  QualifiedIdentifier,
  SelectItem,
  SelectStatement,
  SourceRange,
  SqlDiagnostic,
  Statement,
  TableReference,
  UpdateAssignment,
  UpdateStatement,
  WindowFrameBound,
  WindowSpecification,
  WithClause,
} from "./parser/index.js";
import { walkStatement } from "./parser/index.js";
import { parsePostgresMajor } from "./support.js";
import {
  defaultPostgresTypePolicy,
  isKnownPostgresType,
  mapPostgresType,
  type PostgresTypePolicy,
} from "./type-policy.js";
import {
  postgresCanCoerce,
  postgresCommonType,
  postgresElementType,
  resolvePostgresCandidates,
  resolvePostgresOperator,
  resolvePostgresUnaryOperator,
} from "./type-resolution.js";

interface Relation {
  readonly alias: string;
  readonly table: TableSnapshot;
  readonly qualifiedOnly?: boolean;
  nullable: boolean;
}

interface Scope {
  readonly relations: Relation[];
  readonly usingColumns: Map<string, ResolvedType>;
  readonly windows: Map<string, WindowSpecification>;
  readonly outer?: Scope;
}

interface ResolvedType {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
}

interface FunctionColumn {
  name: string;
  databaseType: string;
  tsType: string;
  nullable: boolean;
}

interface ConflictInferenceElement {
  readonly column?: string;
  readonly columnCaseSensitive?: boolean;
  readonly expressionHash?: string;
  readonly operatorClass?: string;
  readonly operatorClassCaseSensitive?: boolean;
  readonly collation?: string;
  readonly collationCaseSensitive?: boolean;
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

function sqlName(identifier: Identifier): string {
  return identifier.quoted ? identifier.name : identifier.name.toLowerCase();
}

function qualifiedSqlName(identifier: QualifiedIdentifier): string {
  return identifier.parts.map(sqlName).join(".");
}

function qualifiedNameIsCaseSensitive(identifier: QualifiedIdentifier): boolean {
  return identifier.parts.some(({ quoted }) => quoted);
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

function mergeTypeLiterals(left: string, right: string): string {
  if (left === right) return left;
  const leftMembers = left.split(" | ");
  if (leftMembers.includes(right)) return left;
  const rightMembers = right.split(" | ");
  if (rightMembers.includes(left)) return right;
  return unionTypeLiterals([left, right]);
}

const aggregateRoutineRules = new Set([
  "array-aggregate",
  "boolean-aggregate",
  "count",
  "json-aggregate",
  "numeric-aggregate",
  "ordered-set-value",
  "string-aggregate",
]);

const aggregateExtrema = new Set(["MAX", "MIN"]);
const hypotheticalAggregates = new Set(["CUME_DIST", "DENSE_RANK", "PERCENT_RANK", "RANK"]);

function isSpecialGrouping(
  grouping: GroupingElement,
): grouping is Extract<
  GroupingElement,
  { readonly kind: "empty-group" | "grouping-set" | "rollup" | "cube" | "grouping-sets" }
> {
  return ["empty-group", "grouping-set", "rollup", "cube", "grouping-sets"].includes(grouping.kind);
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: PostgresTypePolicy;
  readonly #strictExpressions: boolean;
  readonly #diagnostics: SqlDiagnostic[] = [];
  readonly #parameters = new ParameterCollector();
  readonly #index: ResolverSchemaIndex;
  readonly #serverMajor: number | undefined;
  #insideMergeReturning = false;

  constructor(schema: SchemaSnapshot, options: ResolveOptions) {
    this.#schema = schema;
    this.#index = ResolverSchemaIndex.for(schema);
    this.#policy = options.typePolicy ?? defaultPostgresTypePolicy;
    this.#strictExpressions = options.strictExpressions ?? true;
    this.#serverMajor = parsePostgresMajor(
      schema.server?.versionKey ?? ("version" in schema ? (schema.version ?? "") : ""),
    );
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
    expectedOutput?: readonly (ResolvedType | undefined)[],
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const ctes = this.#resolveWith(statement.with, outer, inheritedCtes);
    switch (statement.kind) {
      case "select":
        return { columns: this.#resolveSelect(statement, outer, ctes, expectedOutput), resultKind: "rows" };
      case "insert":
        return this.#resolveInsert(statement, outer, ctes);
      case "update":
        return this.#resolveUpdate(statement, outer, ctes);
      case "delete":
        return this.#resolveDelete(statement, outer, ctes);
      case "merge":
        return this.#resolveMerge(statement, outer, ctes);
    }
  }

  #resolveWith(
    withClause: WithClause | undefined,
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): Map<string, TableSnapshot> {
    const ctes = new Map(inherited);
    if (withClause === undefined) return ctes;
    for (const query of withClause.queries) {
      const key = sqlName(query.name);
      if (ctes.has(key)) this.#diagnostic("TSQ211", `Duplicate CTE ${query.name.name}`, query.name.range);
      const selfReferences = query.statement.kind === "select" ? this.#selfReferences(query.statement, query.name) : 0;
      if (
        (query.search !== undefined || query.cycle !== undefined) &&
        (!withClause.recursive || selfReferences === 0)
      ) {
        this.#diagnostic("TSQ220", `SEARCH and CYCLE require a recursive CTE ${query.name.name}`, query.range);
      }
      if (selfReferences > 0 && !withClause.recursive) {
        this.#diagnostic("TSQ220", `Recursive CTE ${query.name.name} requires WITH RECURSIVE`, query.range);
      }
      const resolved =
        selfReferences > 0 && query.statement.kind === "select"
          ? this.#resolveRecursiveCte(
              query as CommonTableExpression & { readonly statement: SelectStatement },
              outer,
              ctes,
            )
          : this.#resolveStatement(query.statement, outer, ctes);
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
      const addGenerated = (identifier: Identifier, column: ColumnSnapshot): void => {
        const generatedName = sqlName(identifier);
        if (columns[generatedName] !== undefined) {
          this.#diagnostic(
            "TSQ105",
            `CTE generated column ${identifier.name} conflicts with an output column`,
            identifier.range,
          );
          return;
        }
        columns[generatedName] = column;
      };
      if (query.search !== undefined) {
        for (const identifier of query.search.by) {
          if (columns[sqlName(identifier)] === undefined)
            this.#diagnostic("TSQ101", `Unknown SEARCH column ${identifier.name}`, identifier.range);
        }
        addGenerated(query.search.set, {
          name: sqlName(query.search.set),
          databaseType: query.search.order === "depth" ? "record[]" : "record",
          tsType: "unknown",
          nullable: false,
        });
      }
      if (query.cycle !== undefined) {
        for (const identifier of query.cycle.columns) {
          if (columns[sqlName(identifier)] === undefined)
            this.#diagnostic("TSQ101", `Unknown CYCLE column ${identifier.name}`, identifier.range);
        }
        const markScope: Scope = {
          relations: [],
          usingColumns: new Map(),
          windows: new Map(),
          ...(outer === undefined ? {} : { outer }),
        };
        const markValue =
          query.cycle.markValue === undefined
            ? this.#databaseType("boolean", false)
            : this.#resolveExpression(query.cycle.markValue, markScope, ctes);
        const markDefault =
          query.cycle.markDefault === undefined
            ? this.#databaseType("boolean", false)
            : this.#resolveExpression(query.cycle.markDefault, markScope, ctes, markValue);
        for (const mark of [query.cycle.markValue, query.cycle.markDefault]) {
          if (
            mark !== undefined &&
            mark.kind !== "literal" &&
            !(mark.kind === "cast" && mark.expression.kind === "literal")
          ) {
            this.#diagnostic("TSQ220", "CYCLE mark values must be constants", mark.range);
          }
        }
        addGenerated(query.cycle.set, {
          name: sqlName(query.cycle.set),
          databaseType:
            markValue.databaseType === markDefault.databaseType && markValue.databaseType !== undefined
              ? markValue.databaseType
              : "unknown",
          tsType: mergeTypeLiterals(markValue.tsType, markDefault.tsType),
          nullable: markValue.nullable || markDefault.nullable,
        });
        addGenerated(query.cycle.using, {
          name: sqlName(query.cycle.using),
          databaseType: "record[]",
          tsType: "unknown",
          nullable: false,
        });
      }
      ctes.set(key, { name: key, columns });
    }
    return ctes;
  }

  #resolveRecursiveCte(
    query: CommonTableExpression & { readonly statement: SelectStatement },
    outer: Scope | undefined,
    inherited: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" } {
    const arms = this.#selectArms(query.statement);
    const references = arms.map(({ statement }) => ({
      direct: this.#directSelfReferences(statement, query.name),
      total: this.#selfReferences(statement, query.name),
    }));
    const firstRecursive = references.findIndex(({ total }) => total > 0);
    if (firstRecursive <= 0) {
      this.#diagnostic(
        "TSQ220",
        `Recursive CTE ${query.name.name} requires a non-recursive SELECT before its recursive member`,
        query.range,
      );
    }
    for (let index = Math.max(firstRecursive, 0); index < arms.length; index += 1) {
      const arm = arms[index]!;
      const reference = references[index]!;
      if (reference.total === 0) {
        this.#diagnostic(
          "TSQ220",
          `Non-recursive members of ${query.name.name} must precede recursive members`,
          arm.range,
        );
      } else if (reference.direct !== 1 || reference.total !== 1) {
        this.#diagnostic(
          "TSQ220",
          `Each recursive member of ${query.name.name} must reference itself exactly once in its top-level FROM`,
          arm.statement.range,
        );
      }
      if (arm.operator !== "union") {
        this.#diagnostic("TSQ220", `Recursive members of ${query.name.name} must use UNION or UNION ALL`, arm.range);
      }
    }

    const seedStatements = arms.slice(0, Math.max(firstRecursive, 1)).map(({ statement }) => statement);
    const seedColumns = seedStatements.map((statement) => this.#resolveSelect(statement, outer, inherited));
    const mergedSeed = [...(seedColumns[0] ?? [])];
    for (const columns of seedColumns.slice(1)) this.#mergeCompoundColumns(mergedSeed, columns, query.range);
    const provisional: Record<string, ColumnSnapshot> = {};
    const width = Math.max(query.columns.length, mergedSeed.length);
    for (let index = 0; index < width; index += 1) {
      const seed = mergedSeed[index];
      const name = query.columns[index] === undefined ? seed?.name : sqlName(query.columns[index]!);
      if (name === undefined) continue;
      provisional[name] = {
        name,
        databaseType: seed?.databaseType ?? "unknown",
        tsType: seed?.tsType ?? "unknown",
        nullable: seed?.nullable ?? true,
      };
    }
    const recursiveScope = new Map(inherited);
    recursiveScope.set(sqlName(query.name), { name: sqlName(query.name), columns: provisional });
    return { columns: this.#resolveSelect(query.statement, outer, recursiveScope), resultKind: "rows" };
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
      const [first, ...rest] = this.#selectArms(compound.statement);
      if (first !== undefined)
        arms.push({ ...first, operator: compound.operator, all: compound.all, range: compound.range });
      arms.push(...rest);
    }
    return arms;
  }

  #directSelfReferences(statement: SelectStatement, identifier: Identifier): number {
    return [statement.from, ...statement.joins.map(({ table }) => table)].filter(
      (reference) =>
        reference?.kind === "table" &&
        reference.schema === undefined &&
        sqlName(reference.name) === sqlName(identifier),
    ).length;
  }

  #selfReferences(statement: SelectStatement, identifier: Identifier): number {
    let references = 0;
    walkStatement(statement, {
      table(reference) {
        if (
          reference.kind === "table" &&
          reference.schema === undefined &&
          sqlName(reference.name) === sqlName(identifier)
        ) {
          references += 1;
        }
      },
    });
    return references;
  }

  #resolveSelect(
    statement: SelectStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
    expectedOutput?: readonly (ResolvedType | undefined)[],
  ): readonly ResolvedColumn[] {
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      windows: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    if (statement.from !== undefined) this.#addRelation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#addJoin(join, scope, ctes);
    for (const clause of statement.locking) {
      for (const relation of clause.relations) {
        if (!scope.relations.some(({ alias }) => alias === sqlName(relation))) {
          this.#diagnostic("TSQ103", `Unknown locking relation ${relation.name}`, relation.range);
        }
      }
    }
    for (const window of statement.windows) {
      const name = sqlName(window.name);
      if (scope.windows.has(name)) {
        this.#diagnostic("TSQ222", `Duplicate window ${window.name.name}`, window.name.range);
        continue;
      }
      const resolved = this.#resolveWindowSpecification(window.specification, scope, ctes);
      scope.windows.set(name, resolved);
    }
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    for (const grouping of statement.groupBy) this.#resolveGrouping(grouping, statement.columns, scope, ctes);
    if (statement.having !== undefined)
      this.#resolveExpression(statement.having, scope, ctes, this.#databaseType("boolean", false));
    for (const expression of statement.distinctOn) this.#resolveExpression(expression, scope, ctes);
    for (const order of statement.orderBy) {
      const output = this.#outputReference(order.expression, statement.columns, scope, true);
      this.#resolveExpression(output ?? order.expression, scope, ctes);
    }
    if (statement.distinctOn.length > 0 && statement.orderBy.length > 0) {
      const distinct = new Set(statement.distinctOn.map((expression) => this.#groupKey(expression, scope)));
      const leading = statement.orderBy
        .slice(0, statement.distinctOn.length)
        .map(({ expression }) => this.#outputReference(expression, statement.columns, scope, true) ?? expression)
        .map((expression) => this.#groupKey(expression, scope));
      if (leading.length !== distinct.size || leading.some((key) => !distinct.has(key))) {
        this.#diagnostic(
          "TSQ228",
          "DISTINCT ON expressions must match the leftmost ORDER BY expressions",
          statement.orderBy[0]!.range,
        );
      }
    }
    if (statement.limit !== undefined)
      this.#resolveExpression(statement.limit, scope, ctes, this.#databaseType("integer", false));
    if (statement.offset !== undefined)
      this.#resolveExpression(statement.offset, scope, ctes, this.#databaseType("integer", false));
    if (statement.fetch?.count !== undefined)
      this.#resolveExpression(statement.fetch.count, scope, ctes, this.#databaseType("integer", false));
    const columns = [...this.#resolveItems(statement.columns, scope, ctes, expectedOutput)];
    this.#validateGroupedQuery(statement, columns, scope);
    for (const compound of statement.compounds) {
      const right = this.#resolveSelect(compound.statement, outer, ctes, expectedOutput);
      this.#mergeCompoundColumns(columns, right, compound.range);
    }
    return columns;
  }

  #resolveGrouping(
    grouping: GroupingElement,
    items: readonly SelectItem[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): void {
    if (!isSpecialGrouping(grouping)) {
      const output = this.#outputReference(grouping, items, scope, false);
      this.#resolveExpression(output ?? grouping, scope, ctes);
      return;
    }
    if (grouping.kind !== "empty-group") {
      for (const element of grouping.elements) this.#resolveGrouping(element, items, scope, ctes);
    }
  }

  #outputReference(
    expression: Expression,
    items: readonly SelectItem[],
    scope: Scope,
    preferOutput: boolean,
  ): Expression | undefined {
    if (
      expression.kind === "literal" &&
      typeof expression.value === "number" &&
      Number.isSafeInteger(expression.value) &&
      expression.value >= 1
    ) {
      return items[expression.value - 1]?.expression;
    }
    if (expression.kind !== "column" || expression.relation !== undefined) return undefined;
    const name = sqlName(expression.column);
    if (!preferOutput && this.#columnMatches(undefined, name, scope, expression.column.quoted).length > 0)
      return undefined;
    const matches = items.filter((item) => item.alias !== undefined && sqlName(item.alias) === name);
    if (matches.length > 1) {
      this.#diagnostic("TSQ105", `Output reference ${expression.column.name} is ambiguous`, expression.range);
      return undefined;
    }
    return matches[0]?.expression;
  }

  #validateGroupedQuery(statement: SelectStatement, columns: ResolvedColumn[], scope: Scope): void {
    if (statement.where !== undefined) this.#validateClauseFunctions(statement.where, false, false, "WHERE");
    for (const grouping of statement.groupBy) {
      this.#forEachGroupingExpression(grouping, (expression) =>
        this.#validateClauseFunctions(expression, false, false, "GROUP BY"),
      );
    }
    if (statement.having !== undefined) this.#validateClauseFunctions(statement.having, true, false, "HAVING");
    const aggregateQuery =
      statement.groupBy.length > 0 ||
      statement.having !== undefined ||
      statement.columns.some(({ expression }) => this.#containsAggregate(expression));
    if (!aggregateQuery) return;
    if (statement.locking.length > 0) {
      this.#diagnostic("TSQ228", "Locking clauses are not allowed on grouped queries", statement.locking[0]!.range);
    }
    const groupingSets = this.#expandGroupingList(statement.groupBy, statement.columns, scope);
    const groupedKeys = new Set(groupingSets.flatMap((set) => [...set]));
    for (const item of statement.columns)
      this.#validateGroupedExpression(item.expression, groupedKeys, groupingSets, scope);
    if (statement.having !== undefined) {
      this.#validateGroupedExpression(statement.having, groupedKeys, groupingSets, scope);
    }
    statement.columns.forEach((item, index) => {
      const column = columns[index];
      if (column === undefined) return;
      const keys = this.#columnKeysOutsideAggregates(item.expression, scope);
      if (keys.some((key) => groupingSets.some((set) => !set.has(key)))) {
        columns[index] = { ...column, nullable: true };
      }
    });
  }

  #validateClauseFunctions(
    expression: Expression,
    allowAggregate: boolean,
    allowWindow: boolean,
    clause: string,
  ): void {
    if (expression.kind === "subquery" || expression.kind === "exists") return;
    if (expression.kind === "call") {
      const window = expression.over !== undefined;
      const aggregate = !window && this.#isAggregateCall(expression);
      if (window && !allowWindow) {
        this.#diagnostic("TSQ228", `Window functions are not allowed in ${clause}`, expression.range);
        return;
      }
      if (aggregate && !allowAggregate) {
        this.#diagnostic("TSQ228", `Aggregate functions are not allowed in ${clause}`, expression.range);
        return;
      }
    }
    for (const child of this.#expressionChildren(expression)) {
      this.#validateClauseFunctions(child, allowAggregate, allowWindow, clause);
    }
  }

  #validateGroupedExpression(
    expression: Expression,
    groupedKeys: ReadonlySet<string>,
    groupingSets: readonly ReadonlySet<string>[],
    scope: Scope,
  ): void {
    if (groupedKeys.has(this.#groupKey(expression, scope))) return;
    if (expression.kind === "subquery" || expression.kind === "exists") return;
    if (expression.kind === "call" && expression.over === undefined && this.#isAggregateCall(expression)) return;
    if (expression.kind === "column") {
      const matches = this.#columnMatches(
        expression.relation,
        sqlName(expression.column),
        scope,
        expression.column.quoted,
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      if (match !== undefined && this.#functionallyDependent(match[0], groupingSets)) return;
      this.#diagnostic(
        "TSQ228",
        `Column ${expression.column.name} must appear in GROUP BY or be used in an aggregate`,
        expression.range,
      );
      return;
    }
    for (const child of this.#expressionChildren(expression)) {
      this.#validateGroupedExpression(child, groupedKeys, groupingSets, scope);
    }
  }

  #functionallyDependent(relation: Relation, groupingSets: readonly ReadonlySet<string>[]): boolean {
    const primaryKey = this.#index
      .relation(relation.table)
      ?.constraints.find(({ kind }) => kind === "primary-key")
      ?.columns.map((column) => `column:${relation.alias}.${column.toLowerCase()}`);
    return (
      primaryKey !== undefined &&
      primaryKey.length > 0 &&
      groupingSets.every((set) => primaryKey.every((key) => set.has(key)))
    );
  }

  #containsAggregate(expression: Expression): boolean {
    if (expression.kind === "subquery" || expression.kind === "exists") return false;
    if (expression.kind === "call" && expression.over === undefined && this.#isAggregateCall(expression)) return true;
    return this.#expressionChildren(expression).some((child) => this.#containsAggregate(child));
  }

  #isAggregateCall(expression: CallExpression): boolean {
    const name = expression.name.name.toUpperCase();
    const rule = postgresCatalogRoutineRule(name, this.#schema);
    if (rule !== undefined && aggregateRoutineRules.has(rule)) return true;
    if (aggregateExtrema.has(name)) return true;
    if ((expression.withinGroup?.length ?? 0) > 0 && hypotheticalAggregates.has(name)) return true;
    const schemaName = expression.schema === undefined ? undefined : sqlName(expression.schema);
    return this.#index
      .routineOverloads(sqlName(expression.name), expression.arguments.length, schemaName)
      .some(({ kind }) => kind === "aggregate");
  }

  #expressionChildren(expression: Expression): readonly Expression[] {
    switch (expression.kind) {
      case "array":
      case "row":
        return expression.elements;
      case "call": {
        const window =
          expression.over !== undefined && "partitionBy" in expression.over
            ? [
                ...expression.over.partitionBy,
                ...expression.over.orderBy.map(({ expression: item }) => item),
                ...(expression.over.frame?.start.kind === "preceding" ||
                expression.over.frame?.start.kind === "following"
                  ? [expression.over.frame.start.expression]
                  : []),
                ...(expression.over.frame?.end?.kind === "preceding" || expression.over.frame?.end?.kind === "following"
                  ? [expression.over.frame.end.expression]
                  : []),
              ]
            : [];
        return [
          ...expression.arguments,
          ...(expression.orderBy ?? []).map(({ expression: item }) => item),
          ...(expression.withinGroup ?? []).map(({ expression: item }) => item),
          ...(expression.filter === undefined ? [] : [expression.filter]),
          ...window,
        ];
      }
      case "cast":
      case "unary":
        return [expression.expression];
      case "subscript":
        return [
          expression.expression,
          ...(expression.index === undefined ? [] : [expression.index]),
          ...(expression.lower === undefined ? [] : [expression.lower]),
          ...(expression.upper === undefined ? [] : [expression.upper]),
        ];
      case "binary":
        return [expression.left, expression.right];
      case "case":
        return [
          ...(expression.operand === undefined ? [] : [expression.operand]),
          ...expression.branches.flatMap(({ when, then }) => [when, then]),
          ...(expression.elseExpression === undefined ? [] : [expression.elseExpression]),
        ];
      case "in":
        return [
          expression.expression,
          ...(Array.isArray(expression.values) ? (expression.values as readonly Expression[]) : []),
        ];
      case "between":
        return [expression.expression, expression.lower, expression.upper];
      case "quantified-comparison":
        return [expression.left, ...(expression.right.kind === "select" ? [] : [expression.right])];
      case "column":
      case "exists":
      case "literal":
      case "parameter":
      case "star":
      case "subquery":
        return [];
    }
  }

  #columnKeysOutsideAggregates(expression: Expression, scope: Scope): readonly string[] {
    if (expression.kind === "subquery" || expression.kind === "exists") return [];
    if (expression.kind === "call" && expression.over === undefined && this.#isAggregateCall(expression)) return [];
    if (expression.kind === "call" && postgresCatalogRoutineRule(expression.name.name, this.#schema) === "grouping") {
      return [];
    }
    if (expression.kind === "column") return [this.#groupKey(expression, scope)];
    return this.#expressionChildren(expression).flatMap((child) => this.#columnKeysOutsideAggregates(child, scope));
  }

  #groupKey(expression: Expression, scope: Scope): string {
    if (expression.kind === "column") {
      const matches = this.#columnMatches(
        expression.relation,
        sqlName(expression.column),
        scope,
        expression.column.quoted,
      );
      if (matches.length === 1) return `column:${matches[0]![0].alias}.${matches[0]![1].name.toLowerCase()}`;
    }
    return `expression:${postgresExpressionIdentity(expression)}`;
  }

  #forEachGroupingExpression(grouping: GroupingElement, visit: (expression: Expression) => void): void {
    if (!isSpecialGrouping(grouping)) visit(grouping);
    else if (grouping.kind !== "empty-group")
      for (const element of grouping.elements) this.#forEachGroupingExpression(element, visit);
  }

  #expandGroupingList(
    groupings: readonly GroupingElement[],
    items: readonly SelectItem[],
    scope: Scope,
  ): readonly ReadonlySet<string>[] {
    let result: ReadonlySet<string>[] = [new Set()];
    for (const grouping of groupings) {
      const alternatives = this.#expandGrouping(grouping, items, scope);
      result = result.flatMap((left) => alternatives.map((right) => new Set([...left, ...right])));
    }
    return result;
  }

  #expandGrouping(
    grouping: GroupingElement,
    items: readonly SelectItem[],
    scope: Scope,
  ): readonly ReadonlySet<string>[] {
    if (grouping.kind === "empty-group") return [new Set()];
    if (!isSpecialGrouping(grouping)) {
      const expression = this.#outputReference(grouping, items, scope, false) ?? grouping;
      return [new Set([this.#groupKey(expression, scope)])];
    }
    if (grouping.kind === "grouping-sets") {
      return grouping.elements.flatMap((element) => this.#expandGrouping(element, items, scope));
    }
    const units = grouping.elements.map((element) => {
      const expanded = this.#expandGrouping(element, items, scope);
      return new Set(expanded.flatMap((set) => [...set]));
    });
    if (grouping.kind === "grouping-set") {
      return [new Set(units.flatMap((set) => [...set]))];
    }
    if (grouping.kind === "rollup") {
      return Array.from(
        { length: units.length + 1 },
        (_, omitted) => new Set(units.slice(0, units.length - omitted).flatMap((set) => [...set])),
      );
    }
    return Array.from(
      { length: 2 ** units.length },
      (_, mask) => new Set(units.flatMap((set, index) => ((mask & (1 << index)) === 0 ? [] : [...set]))),
    );
  }

  #resolveWindowSpecification(
    specification: WindowSpecification,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): WindowSpecification {
    const base = specification.base === undefined ? undefined : scope.windows.get(sqlName(specification.base));
    if (specification.base !== undefined && base === undefined) {
      this.#diagnostic("TSQ222", `Unknown window ${specification.base.name}`, specification.base.range);
    }
    if (base !== undefined && specification.partitionBy.length > 0) {
      this.#diagnostic("TSQ222", "A derived window cannot override PARTITION BY", specification.range);
    }
    if (base !== undefined && base.orderBy.length > 0 && specification.orderBy.length > 0) {
      this.#diagnostic("TSQ222", "A derived window cannot override ORDER BY", specification.range);
    }
    if (base?.frame !== undefined) {
      this.#diagnostic("TSQ222", "A framed window cannot be inherited", specification.range);
    }
    const partitionBy = specification.partitionBy.length > 0 ? specification.partitionBy : (base?.partitionBy ?? []);
    const orderBy = specification.orderBy.length > 0 ? specification.orderBy : (base?.orderBy ?? []);
    for (const expression of specification.partitionBy) this.#resolveExpression(expression, scope, ctes);
    for (const order of specification.orderBy) this.#resolveExpression(order.expression, scope, ctes);
    if (specification.frame !== undefined) {
      const { frame } = specification;
      if (frame.start.kind === "unbounded-following") {
        this.#diagnostic("TSQ222", "A window frame cannot start with UNBOUNDED FOLLOWING", frame.start.range);
      }
      if (frame.end?.kind === "unbounded-preceding") {
        this.#diagnostic("TSQ222", "A window frame cannot end with UNBOUNDED PRECEDING", frame.end.range);
      }
      const boundRank = (bound: WindowFrameBound): number => {
        if (bound.kind === "unbounded-preceding") return 0;
        if (bound.kind === "preceding") return 1;
        if (bound.kind === "current-row") return 2;
        if (bound.kind === "following") return 3;
        return 4;
      };
      if (frame.end !== undefined && boundRank(frame.start) > boundRank(frame.end)) {
        this.#diagnostic("TSQ222", "A window frame end cannot precede its start", frame.range);
      }
      const offsetBounds = [frame.start, frame.end].filter(
        (bound): bound is Extract<WindowFrameBound, { readonly kind: "preceding" | "following" }> =>
          bound?.kind === "preceding" || bound?.kind === "following",
      );
      if (frame.unit === "range" && offsetBounds.length > 0 && orderBy.length !== 1) {
        this.#diagnostic("TSQ222", "RANGE offset frames require exactly one ORDER BY expression", frame.range);
      }
      for (const bound of offsetBounds) {
        const orderType =
          frame.unit === "range" && orderBy.length === 1
            ? this.#resolveExpression(orderBy[0]!.expression, scope, ctes)
            : undefined;
        const expected =
          frame.unit === "range"
            ? orderType?.databaseType !== undefined && this.#isNumericType(orderType.databaseType)
              ? orderType
              : undefined
            : this.#databaseType("integer", false);
        this.#resolveExpression(bound.expression, scope, ctes, expected);
      }
    }
    return {
      ...specification,
      partitionBy,
      orderBy,
    };
  }

  #mergeCompoundColumns(columns: ResolvedColumn[], right: readonly ResolvedColumn[], range: SourceRange): void {
    if (right.length !== columns.length) {
      this.#diagnostic(
        "TSQ214",
        `Compound query has ${columns.length} columns on the left and ${right.length} on the right`,
        range,
      );
      return;
    }
    for (let index = 0; index < columns.length; index += 1) {
      const left = columns[index]!;
      const candidate = right[index]!;
      const { databaseType: _databaseType, ...base } = left;
      columns[index] = {
        ...base,
        tsType: mergeTypeLiterals(left.tsType, candidate.tsType),
        nullable: left.nullable || candidate.nullable,
        ...(left.databaseType === candidate.databaseType && left.databaseType !== undefined
          ? { databaseType: left.databaseType }
          : {}),
      };
    }
  }

  #resolveInsert(
    statement: Extract<Statement, { readonly kind: "insert" }>,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      windows: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    const allTargetColumns = Object.values(target?.table.columns ?? {});
    let targetColumns =
      statement.columns.length > 0
        ? statement.columns.map((column) => this.#findColumn(target?.table, column))
        : statement.source.kind === "values"
          ? allTargetColumns.slice(0, statement.source.rows[0]?.length ?? 0)
          : statement.source.kind === "default-values"
            ? []
            : allTargetColumns;
    const insertNames = statement.columns.map(sqlName);
    if (new Set(insertNames).size !== insertNames.length)
      this.#diagnostic("TSQ227", "INSERT cannot target the same column more than once", statement.table.range);
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
          const resolved = this.#resolveExpression(value, scope, ctes, this.#snapshotType(targetColumns[index]));
          this.#validateWriteValue(targetColumns[index], resolved, value.range, "INSERT");
        });
      }
    } else if (statement.source.kind === "select") {
      const source = this.#resolveStatement(
        statement.source,
        outer,
        ctes,
        targetColumns.map((column) => this.#snapshotType(column)),
      );
      if (statement.columns.length === 0) targetColumns = allTargetColumns.slice(0, source.columns.length);
      if (
        (statement.columns.length > 0 && source.columns.length !== targetColumns.length) ||
        source.columns.length > allTargetColumns.length
      ) {
        this.#diagnostic(
          "TSQ214",
          `INSERT has ${targetColumns.length} target columns but SELECT returns ${source.columns.length}`,
          statement.source.range,
        );
      }
      this.#validateWriteColumns(targetColumns, source.columns, statement.source.range, "INSERT");
    }
    if (target !== undefined) {
      targetColumns.forEach((column, index) => {
        if (column === undefined) return;
        const evidence = this.#index.columnEvidence(target.table, column);
        const identityOverride = statement.overriding !== undefined && evidence?.identity !== "none";
        const defaultOnly =
          statement.source.kind === "default-values" ||
          (statement.source.kind === "values" &&
            statement.source.rows.every((row) => this.#isDefaultValue(row[index])));
        if (
          this.#index.columnEligibility(target.table, column, "insert") === false &&
          !identityOverride &&
          !defaultOnly
        ) {
          this.#diagnostic(
            "TSQ218",
            `Cannot INSERT into non-insertable column ${column.name}`,
            statement.columns[index]?.range ?? statement.source.range,
          );
        }
      });
      const supplied = new Set(
        targetColumns.flatMap((column, index) => {
          if (column === undefined || statement.source.kind === "default-values") return [];
          if (
            statement.source.kind === "values" &&
            statement.source.rows.every((row) => this.#isDefaultValue(row[index]))
          )
            return [];
          return [column.name.toLowerCase()];
        }),
      );
      const required = this.#index.requiredInsertColumns(target.table);
      if (required !== "unknown") {
        for (const column of required) {
          if (!supplied.has(column.name.toLowerCase())) {
            this.#diagnostic("TSQ219", `INSERT omits required column ${column.name}`, statement.table.range);
          }
        }
      }
    }
    if (statement.conflict !== undefined && target !== undefined) {
      const conflict = statement.conflict;
      if (conflict.action.kind === "update" && conflict.target === undefined) {
        this.#diagnostic("TSQ227", "ON CONFLICT DO UPDATE requires a conflict target", conflict.range);
      }
      if (conflict.target?.kind === "constraint") {
        const targetConstraint = conflict.target;
        const requested = sqlName(targetConstraint.constraint);
        const relation = this.#index.relation(target.table);
        const match = relation?.constraints.find((constraint) => {
          if (constraint.kind !== "primary-key" && constraint.kind !== "unique" && constraint.kind !== "exclusion")
            return false;
          const name = constraint.identity.slice(constraint.identity.lastIndexOf(".") + 1);
          return targetConstraint.constraint.quoted ? name === requested : name.toLowerCase() === requested;
        });
        if (relation !== undefined && match === undefined) {
          this.#diagnostic("TSQ226", `Unknown conflict constraint ${requested}`, conflict.target.range);
        } else if (relation === undefined) {
          this.#diagnostic(
            "TSQ402",
            `Conflict constraint ${requested} requires schema snapshot v2 evidence`,
            conflict.target.range,
            undefined,
            "warning",
          );
        } else if (match?.deferrable === true) {
          this.#diagnostic(
            "TSQ224",
            `Deferrable constraint ${requested} cannot arbitrate ON CONFLICT`,
            conflict.target.range,
          );
        } else if (match !== undefined && (match.deferrable === "unknown" || match.deferrable === undefined)) {
          this.#diagnostic(
            "TSQ402",
            `Conflict constraint ${requested} has unknown deferrability`,
            conflict.target.range,
            undefined,
            "warning",
          );
        } else if (match?.kind === "exclusion" && conflict.action.kind === "update") {
          this.#diagnostic(
            "TSQ224",
            "Exclusion constraints cannot arbitrate ON CONFLICT DO UPDATE",
            conflict.target.range,
          );
        }
      } else if (conflict.target?.kind === "inference") {
        for (const element of conflict.target.elements) {
          this.#resolveExpression(element.expression, scope, ctes);
        }
        if (conflict.target.predicate !== undefined)
          this.#resolveExpression(conflict.target.predicate, scope, ctes, this.#databaseType("boolean", false));
        const inference = this.#matchConflictInference(target.table, conflict.target);
        if (inference === "unknown") {
          this.#diagnostic(
            "TSQ402",
            "Exact conflict-target inference requires canonical schema snapshot v2 evidence",
            conflict.target.range,
            undefined,
            "warning",
          );
        } else if (!inference) {
          this.#diagnostic(
            "TSQ226",
            "Conflict target does not match a valid unique index or primary-key constraint",
            conflict.target.range,
          );
        }
      }
      if (conflict.action.kind === "update") {
        const excludedAlias = "excluded";
        if (scope.relations.some(({ alias }) => alias === excludedAlias))
          this.#diagnostic(
            "TSQ108",
            "INSERT target alias excluded conflicts with the ON CONFLICT excluded row",
            statement.table.range,
          );
        const conflictScope: Scope = {
          ...scope,
          relations: [
            ...scope.relations.filter(({ alias }) => alias !== excludedAlias),
            { alias: excludedAlias, table: target.table, nullable: false, qualifiedOnly: true },
          ],
        };
        this.#resolveAssignments(conflict.action.assignments, target.table, conflictScope, ctes);
        if (conflict.action.where !== undefined)
          this.#resolveExpression(conflict.action.where, conflictScope, ctes, this.#databaseType("boolean", false));
      }
    }
    const returningScope = this.#returningScope(
      scope,
      target?.table,
      statement.returningAliases,
      statement.returning,
      "insert",
    );
    const columns = this.#resolveItems(statement.returning, returningScope, ctes);
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveUpdate(
    statement: UpdateStatement,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      windows: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    if (statement.from !== undefined) this.#addRelation(statement.from, false, scope, ctes);
    for (const join of statement.joins) this.#addJoin(join, scope, ctes);
    this.#resolveAssignments(statement.assignments, target?.table, scope, ctes);
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    const columns = this.#resolveItems(
      statement.returning,
      this.#returningScope(scope, target?.table, statement.returningAliases, statement.returning, "update"),
      ctes,
    );
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveDelete(
    statement: Extract<Statement, { readonly kind: "delete" }>,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      windows: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    for (const reference of statement.using) this.#addRelation(reference, false, scope, ctes);
    for (const join of statement.joins) this.#addJoin(join, scope, ctes);
    if (statement.where !== undefined)
      this.#resolveExpression(statement.where, scope, ctes, this.#databaseType("boolean", false));
    const columns = this.#resolveItems(
      statement.returning,
      this.#returningScope(scope, target?.table, statement.returningAliases, statement.returning, "delete"),
      ctes,
    );
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveMerge(
    statement: Extract<Statement, { readonly kind: "merge" }>,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): { readonly columns: readonly ResolvedColumn[]; readonly resultKind: "rows" | "command" } {
    this.#requireServerMajor(15, "MERGE", statement.range);
    if (statement.with?.recursive)
      this.#diagnostic("TSQ227", "MERGE does not support WITH RECURSIVE", statement.with.range);
    const scope: Scope = {
      relations: [],
      usingColumns: new Map(),
      windows: new Map(),
      ...(outer === undefined ? {} : { outer }),
    };
    const target = this.#addRelation(statement.table, false, scope, ctes);
    const targetAlias = target?.alias;
    if (statement.source.kind === "values") {
      const rows = statement.source.rows.map((row) =>
        row.map((expression) => this.#resolveExpression(expression, { ...scope, relations: [] }, ctes)),
      );
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (rows.some((row) => row.length !== width))
        this.#diagnostic("TSQ214", "MERGE VALUES source rows must have equal arity", statement.source.range);
      if (statement.source.columns.length > 0 && statement.source.columns.length !== width)
        this.#diagnostic("TSQ214", "MERGE VALUES source alias list does not match row arity", statement.source.range);
      const columns: Record<string, ColumnSnapshot> = {};
      for (let index = 0; index < width; index += 1) {
        const candidates = rows.map((row) => row[index]).filter((value): value is ResolvedType => value !== undefined);
        const name = statement.source.columns[index]?.name ?? `column${index + 1}`;
        columns[name] = {
          name,
          databaseType: candidates[0]?.databaseType ?? "unknown",
          tsType: unionTypeLiterals(candidates.map(({ tsType }) => tsType)),
          nullable: candidates.some(({ nullable }) => nullable),
        };
      }
      const sourceAlias =
        statement.source.alias === undefined
          ? `*merge-values*${statement.source.range.start}`
          : sqlName(statement.source.alias);
      if (sourceAlias === targetAlias)
        this.#diagnostic("TSQ108", `Duplicate relation alias ${sourceAlias}`, statement.source.range);
      scope.relations.push({
        alias: sourceAlias,
        table: { name: statement.source.alias?.name ?? sourceAlias, columns },
        nullable: false,
      });
    } else this.#addRelation(statement.source, false, scope, ctes);
    this.#resolveExpression(statement.on, scope, ctes, this.#databaseType("boolean", false));
    const terminal = new Set<string>();
    for (const clause of statement.clauses) {
      if (clause.by !== undefined)
        this.#requireServerMajor(17, `MERGE WHEN NOT MATCHED BY ${clause.by.toUpperCase()}`, clause.range);
      if (terminal.has(clause.match))
        this.#diagnostic("TSQ227", `Unreachable MERGE ${clause.match} clause`, clause.range);
      if (clause.condition === undefined) terminal.add(clause.match);
      const clauseScope: Scope = {
        ...scope,
        relations: scope.relations.filter(({ alias }) => {
          if (clause.match === "matched") return true;
          return clause.match === "not-matched-source" ? alias === targetAlias : alias !== targetAlias;
        }),
      };
      if (clause.condition !== undefined)
        this.#resolveExpression(clause.condition, clauseScope, ctes, this.#databaseType("boolean", false));
      const action = clause.action;
      if (action.kind === "insert") {
        if (clause.match !== "not-matched-target")
          this.#diagnostic("TSQ227", "MERGE INSERT is only valid for NOT MATCHED BY TARGET", action.range);
        const actionNames = action.columns.map(sqlName);
        if (new Set(actionNames).size !== actionNames.length)
          this.#diagnostic("TSQ227", "MERGE INSERT cannot target the same column more than once", action.range);
        if (action.source.kind === "default-values" && action.overriding !== undefined)
          this.#diagnostic("TSQ227", "MERGE DEFAULT VALUES cannot use OVERRIDING", action.range);
        const targetColumns =
          action.columns.length === 0
            ? Object.values(target?.table.columns ?? {})
            : action.columns.map((column) => this.#findColumn(target?.table, column));
        if (target !== undefined) {
          targetColumns.forEach((column, index) => {
            if (column === undefined) return;
            const evidence = this.#index.columnEvidence(target.table, column);
            const identityOverride = action.overriding !== undefined && evidence?.identity !== "none";
            const defaultOnly =
              action.source.kind === "default-values" ||
              action.source.rows.every((row) => this.#isDefaultValue(row[index]));
            if (
              this.#index.columnEligibility(target.table, column, "insert") === false &&
              !identityOverride &&
              !defaultOnly
            ) {
              this.#diagnostic(
                "TSQ218",
                `Cannot INSERT into non-insertable column ${column.name}`,
                action.columns[index]?.range ?? action.range,
              );
            }
          });
          const supplied = new Set<string>();
          if (action.source.kind === "values") {
            const rows = action.source.rows;
            targetColumns.forEach((column, index) => {
              if (column !== undefined && !rows.every((row) => this.#isDefaultValue(row[index])))
                supplied.add(column.name.toLowerCase());
            });
          }
          const required = this.#index.requiredInsertColumns(target.table);
          if (required !== "unknown") {
            for (const column of required) {
              if (!supplied.has(column.name.toLowerCase()))
                this.#diagnostic("TSQ219", `MERGE INSERT omits required column ${column.name}`, action.range);
            }
          }
        }
        if (action.source.kind === "values") {
          const values = action.source.rows[0] ?? [];
          if (values.length !== targetColumns.length)
            this.#diagnostic(
              "TSQ214",
              `MERGE INSERT has ${targetColumns.length} columns but ${values.length} values`,
              action.range,
            );
          values.forEach((value, index) => {
            const resolved = this.#resolveExpression(
              value,
              clauseScope,
              ctes,
              this.#snapshotType(targetColumns[index]),
            );
            this.#validateWriteValue(targetColumns[index], resolved, value.range, "MERGE INSERT");
          });
        }
      } else if (action.kind === "update") {
        if (clause.match === "not-matched-target")
          this.#diagnostic("TSQ227", "MERGE UPDATE cannot modify an unmatched target row", action.range);
        this.#resolveAssignments(action.assignments, target?.table, clauseScope, ctes);
      } else if (action.kind === "delete" && clause.match === "not-matched-target") {
        this.#diagnostic("TSQ227", "MERGE DELETE cannot delete an unmatched target row", action.range);
      }
    }
    if (statement.returning.length > 0) this.#requireServerMajor(17, "MERGE RETURNING", statement.range);
    const returningScope = this.#returningScope(
      scope,
      target?.table,
      statement.returningAliases,
      statement.returning,
      "merge",
    );
    this.#insideMergeReturning = true;
    const columns = this.#resolveItems(statement.returning, returningScope, ctes);
    this.#insideMergeReturning = false;
    return { columns, resultKind: statement.returning.length === 0 ? "command" : "rows" };
  }

  #resolveAssignments(
    assignments: readonly UpdateAssignment[],
    table: TableSnapshot | undefined,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): void {
    const assigned = new Set<string>();
    for (const assignment of assignments) {
      const identifiers = "column" in assignment ? [assignment.column] : assignment.columns;
      const names = identifiers.map(sqlName);
      if (new Set(names).size !== names.length || names.some((name) => assigned.has(name))) {
        this.#diagnostic("TSQ227", "An assignment cannot target the same column more than once", assignment.range);
      }
      for (const name of names) assigned.add(name);
      const columns = identifiers.map((identifier) => this.#findColumn(table, identifier));
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        if (
          table !== undefined &&
          column !== undefined &&
          this.#index.columnEligibility(table, column, "update") === false
        ) {
          this.#diagnostic("TSQ218", `Cannot UPDATE non-updatable column ${column.name}`, identifiers[index]!.range);
        }
      }
      if (identifiers.length === 1) {
        const resolved = this.#resolveExpression(assignment.value, scope, ctes, this.#snapshotType(columns[0]));
        this.#validateWriteValue(columns[0], resolved, assignment.value.range, "UPDATE");
      } else if (assignment.value.kind === "row") {
        assignment.value.elements.forEach((element, index) => {
          const resolved = this.#resolveExpression(element, scope, ctes, this.#snapshotType(columns[index]));
          this.#validateWriteValue(columns[index], resolved, element.range, "row assignment");
        });
        if (assignment.value.elements.length !== identifiers.length)
          this.#diagnostic(
            "TSQ214",
            `Row assignment has ${identifiers.length} targets but ${assignment.value.elements.length} values`,
            assignment.range,
          );
      } else if (assignment.value.kind === "subquery") {
        const resolved = this.#resolveStatement(
          assignment.value.query,
          scope,
          ctes,
          columns.map((column) => this.#snapshotType(column)),
        );
        if (resolved.columns.length !== identifiers.length)
          this.#diagnostic(
            "TSQ214",
            `Row assignment has ${identifiers.length} targets but subquery returns ${resolved.columns.length} columns`,
            assignment.range,
          );
        this.#validateWriteColumns(columns, resolved.columns, assignment.range, "row assignment");
      } else {
        this.#resolveExpression(assignment.value, scope, ctes);
        this.#diagnostic("TSQ227", "Multi-column assignment requires a row or scalar subquery", assignment.range);
      }
    }
  }

  #returningScope(
    scope: Scope,
    table: TableSnapshot | undefined,
    aliases: { readonly old?: Identifier; readonly new?: Identifier; readonly range: SourceRange } | undefined,
    items: readonly SelectItem[],
    operation: "insert" | "update" | "delete" | "merge",
  ): Scope {
    if (aliases !== undefined) this.#requireServerMajor(18, "RETURNING OLD/NEW aliases", aliases.range);
    if (
      aliases === undefined &&
      items.some(({ expression }) => this.#referencesDefaultReturningRow(expression, scope))
    ) {
      this.#requireServerMajor(18, "RETURNING OLD/NEW rows", items[0]!.range);
    }
    if (items.length === 0) return scope;
    if (table === undefined || (aliases === undefined && (this.#serverMajor ?? 0) < 18)) return scope;
    const oldAlias = aliases?.old === undefined ? "old" : sqlName(aliases.old);
    const newAlias = aliases?.new === undefined ? "new" : sqlName(aliases.new);
    const hiddenOld = aliases !== undefined && aliases.old !== undefined;
    const hiddenNew = aliases !== undefined && aliases.new !== undefined;
    if (oldAlias === newAlias)
      this.#diagnostic(
        "TSQ108",
        `RETURNING OLD and NEW rows cannot share alias ${oldAlias}`,
        aliases?.range ?? items[0]!.range,
      );
    for (const alias of [oldAlias, newAlias]) {
      if (scope.relations.some((relation) => relation.alias === alias))
        this.#diagnostic(
          "TSQ108",
          `RETURNING row alias ${alias} conflicts with an existing relation`,
          aliases?.range ?? items[0]!.range,
        );
    }
    return {
      ...scope,
      relations: [
        ...scope.relations,
        ...(!hiddenOld || aliases?.old !== undefined
          ? [{ alias: oldAlias, table, nullable: operation === "insert" || operation === "merge", qualifiedOnly: true }]
          : []),
        ...(!hiddenNew || aliases?.new !== undefined
          ? [{ alias: newAlias, table, nullable: operation === "delete" || operation === "merge", qualifiedOnly: true }]
          : []),
      ],
    };
  }

  #referencesDefaultReturningRow(expression: Expression, scope: Scope): boolean {
    if (
      expression.kind === "column" &&
      expression.relation !== undefined &&
      (sqlName(expression.relation) === "old" || sqlName(expression.relation) === "new") &&
      !scope.relations.some(({ alias }) => alias === sqlName(expression.relation!))
    )
      return true;
    if (expression.kind === "star" && expression.relation !== undefined) {
      const alias = sqlName(expression.relation);
      return (alias === "old" || alias === "new") && !scope.relations.some((relation) => relation.alias === alias);
    }
    return this.#expressionChildren(expression).some((child) => this.#referencesDefaultReturningRow(child, scope));
  }

  #requireServerMajor(minimum: number, feature: string, range: SourceRange): void {
    if (this.#serverMajor === undefined) {
      this.#diagnostic("TSQ402", `${feature} requires PostgreSQL server-version evidence`, range);
    } else if (this.#serverMajor < minimum) {
      this.#diagnostic("TSQ403", `${feature} requires PostgreSQL ${minimum} or newer`, range);
    }
  }

  #addJoin(join: SelectStatement["joins"][number], scope: Scope, ctes: ReadonlyMap<string, TableSnapshot>): void {
    const previous = [...scope.relations];
    if (join.kind === "right" || join.kind === "full") for (const relation of previous) relation.nullable = true;
    const restrictLateral =
      (join.kind === "right" || join.kind === "full") &&
      (join.table.kind === "function" || (join.table.kind === "subquery" && join.table.lateral));
    const relationScope: Scope = restrictLateral
      ? {
          relations: [],
          usingColumns: new Map(),
          windows: scope.windows,
          ...(scope.outer === undefined ? {} : { outer: scope.outer }),
        }
      : scope;
    const relation = this.#addRelation(join.table, join.kind === "left" || join.kind === "full", relationScope, ctes);
    if (restrictLateral && relation !== undefined) {
      if (scope.relations.some(({ alias }) => alias === relation.alias)) {
        this.#diagnostic("TSQ108", `Duplicate relation alias ${relation.alias}`, join.table.range);
      } else scope.relations.push(relation);
    }
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
    if (reference.kind === "function") {
      table = this.#resolveFunctionTable(reference, scope, ctes);
      alias = reference.alias === undefined ? sqlName(reference.functions[0]!.call.name) : sqlName(reference.alias);
    } else if (reference.kind === "subquery") {
      if (reference.alias === undefined) this.#requireServerMajor(16, "Unaliased derived tables", reference.range);
      const outer = reference.lateral ? scope : scope.outer;
      const resolved = this.#resolveStatement(reference.query, outer, ctes);
      const columns: Record<string, ColumnSnapshot> = {};
      resolved.columns.forEach((column, index) => {
        const name = reference.columns[index] === undefined ? column.name : sqlName(reference.columns[index]!);
        columns[name] = {
          name,
          databaseType: column.databaseType ?? "unknown",
          tsType: column.tsType,
          nullable: column.nullable,
        };
      });
      if (reference.columns.length > 0 && reference.columns.length !== resolved.columns.length)
        this.#diagnostic("TSQ213", "Derived-table column alias list has the wrong arity", reference.range);
      alias = reference.alias === undefined ? `*derived*${reference.range.start}` : sqlName(reference.alias);
      table = { name: alias, columns };
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
    if (reference.kind === "table" && reference.sample !== undefined) {
      const sampleMethod = reference.sample.method.name.toUpperCase();
      if ((sampleMethod === "SYSTEM" || sampleMethod === "BERNOULLI") && reference.sample.arguments.length !== 1) {
        this.#diagnostic(
          "TSQ227",
          `${sampleMethod} TABLESAMPLE requires one percentage argument`,
          reference.sample.range,
        );
      }
      if (reference.sample.repeatable?.kind === "literal" && reference.sample.repeatable.value === null) {
        this.#diagnostic("TSQ227", "TABLESAMPLE REPEATABLE seed cannot be NULL", reference.sample.repeatable.range);
      }
      const sampleScope: Scope = {
        relations: [],
        usingColumns: new Map(),
        windows: scope.windows,
        ...(scope.outer === undefined ? {} : { outer: scope.outer }),
      };
      for (const argument of reference.sample.arguments) {
        this.#resolveExpression(argument, sampleScope, ctes, this.#databaseType("numeric", false));
      }
      if (reference.sample.repeatable !== undefined) {
        this.#resolveExpression(
          reference.sample.repeatable,
          sampleScope,
          ctes,
          this.#databaseType("double precision", false),
        );
      }
    }
    return relation;
  }

  #resolveFunctionTable(
    reference: FunctionTableReference,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): TableSnapshot {
    const outerDefinitions = reference.columns.some(({ databaseType }) => databaseType !== undefined);
    const directDefinitions =
      reference.functions.length === 1 &&
      reference.columns.length > 0 &&
      reference.columns.every(({ databaseType }) => databaseType !== undefined);
    if (
      outerDefinitions &&
      (reference.withOrdinality || (reference.rowsFrom === true && reference.functions.length > 1))
    ) {
      this.#diagnostic(
        "TSQ227",
        "An outer record definition list requires one function and cannot be combined with WITH ORDINALITY",
        reference.range,
      );
    }
    const resolvedColumns = reference.functions.flatMap((item) =>
      this.#resolveTableFunctionItem(directDefinitions ? { ...item, columns: reference.columns } : item, scope, ctes),
    );
    if (reference.functions.length > 1) {
      for (const column of resolvedColumns) column.nullable = true;
    }
    if (reference.withOrdinality) {
      resolvedColumns.push({
        name: "ordinality",
        databaseType: "bigint",
        tsType: this.#policy.bigint,
        nullable: false,
      });
    }
    (directDefinitions ? [] : reference.columns).forEach((definition, index) => {
      const column = resolvedColumns[index];
      if (column === undefined) {
        this.#diagnostic("TSQ213", "Table-function column alias list has more names than outputs", definition.range);
        return;
      }
      column.name = sqlName(definition.name);
      if (definition.databaseType !== undefined) {
        column.databaseType = normalizeDatabaseType(definition.databaseType.name);
        column.tsType = mapPostgresType(definition.databaseType.name, this.#policy, this.#schema);
      }
    });
    const columns: Record<string, ColumnSnapshot> = {};
    for (const column of resolvedColumns) {
      if (columns[column.name] !== undefined) {
        this.#diagnostic("TSQ105", `Duplicate table-function column ${column.name}`, reference.range);
        continue;
      }
      columns[column.name] = column;
    }
    return {
      name: reference.alias === undefined ? sqlName(reference.functions[0]!.call.name) : sqlName(reference.alias),
      columns,
    };
  }

  #resolveTableFunctionItem(
    item: FunctionTableReference["functions"][number],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): FunctionColumn[] {
    const expression = item.call;
    const argumentsList = expression.arguments.map((argument) => this.#resolveExpression(argument, scope, ctes));
    if (item.columns.length > 0) {
      return item.columns.map((definition) => ({
        name: sqlName(definition.name),
        databaseType: definition.databaseType?.name ?? "unknown",
        tsType:
          definition.databaseType === undefined
            ? "unknown"
            : mapPostgresType(definition.databaseType.name, this.#policy, this.#schema),
        nullable: true,
      }));
    }
    const functionName = sqlName(expression.name);
    const schemaName = expression.schema === undefined ? undefined : sqlName(expression.schema);
    const routines = this.#index.routineOverloads(functionName, expression.arguments.length, schemaName);
    const selectedRoutine = this.#selectTableRoutine(routines, argumentsList, expression);
    if (selectedRoutine !== undefined) {
      const { routine, argumentTypes, resultType } = selectedRoutine;
      expression.arguments.forEach((argument, index) => {
        if (argument.kind === "parameter") {
          this.#resolveExpression(argument, scope, ctes, this.#databaseType(argumentTypes[index]!, true));
        }
      });
      const result = routine.result;
      if (result.kind === "record" || result.kind === "table") {
        return Object.values(result.columns)
          .sort((left, right) => left.position - right.position)
          .map((column) => ({
            name: column.name,
            databaseType: column.databaseType,
            tsType: column.tsType,
            nullable: column.nullable,
          }));
      }
      if (result.kind === "scalar" || result.kind === "set") {
        return [
          {
            name: functionName,
            databaseType: resultType,
            tsType:
              resultType === normalizeDatabaseType(result.databaseType)
                ? result.tsType
                : mapPostgresType(resultType, this.#policy, this.#schema),
            nullable: result.nullable,
          },
        ];
      }
      this.#diagnostic("TSQ212", `Routine ${expression.name.name} does not return rows`, expression.range);
      return [];
    }
    const rule = postgresCatalogTableRoutineRule(expression.name.name, this.#schema);
    if (rule === "array-elements") {
      return argumentsList.map((argument, index) => ({
        name: index === 0 ? functionName : `${functionName}_${index + 1}`,
        databaseType: argument.databaseType?.replace(/\[\]$/u, "") ?? "unknown",
        tsType: this.#arrayElementType(argument.tsType),
        nullable: true,
      }));
    }
    if (rule === "first-argument") {
      const value = argumentsList[0] ?? { tsType: "unknown", nullable: true };
      return [
        { name: functionName, databaseType: value.databaseType ?? "unknown", tsType: value.tsType, nullable: false },
      ];
    }
    if (rule === "integer") {
      return [{ name: functionName, databaseType: "integer", tsType: "number", nullable: false }];
    }
    if (rule === "json-each" || rule === "json-each-text") {
      const json = rule === "json-each";
      return [
        { name: "key", databaseType: "text", tsType: "string", nullable: false },
        {
          name: "value",
          databaseType: json ? (expression.name.name.toUpperCase().startsWith("JSONB") ? "jsonb" : "json") : "text",
          tsType: json ? this.#policy.json : "string",
          nullable: false,
        },
      ];
    }
    if (rule === "json-array-elements" || rule === "json-array-elements-text") {
      const json = rule === "json-array-elements";
      return [
        {
          name: "value",
          databaseType: json ? (expression.name.name.toUpperCase().startsWith("JSONB") ? "jsonb" : "json") : "text",
          tsType: json ? this.#policy.json : "string",
          nullable: false,
        },
      ];
    }
    if (rule === "record") {
      this.#diagnostic(
        "TSQ213",
        `Record-returning routine ${expression.name.name} requires a typed column definition list`,
        expression.range,
      );
      return [];
    }
    const candidates = this.#index.functions(functionName, expression.arguments.length, schemaName);
    if (candidates.length === 1) {
      const type = this.#functionType(candidates[0]!);
      return [
        {
          name: functionName,
          databaseType: type.databaseType ?? "unknown",
          tsType: type.tsType,
          nullable: type.nullable,
        },
      ];
    }
    this.#diagnostic(
      "TSQ202",
      `Unknown table function ${expression.name.name}`,
      expression.range,
      undefined,
      "warning",
    );
    return [{ name: functionName, databaseType: "unknown", tsType: "unknown", nullable: true }];
  }

  #selectTableRoutine(
    candidates: readonly StructuralRoutineSnapshot[],
    argumentsList: readonly ResolvedType[],
    expression: CallExpression,
  ):
    | {
        readonly routine: StructuralRoutineSnapshot;
        readonly argumentTypes: readonly string[];
        readonly resultType: string;
      }
    | undefined {
    const result = resolvePostgresCandidates(
      candidates.flatMap((candidate) => {
        const routineResult = candidate.result;
        if (routineResult.kind === "void" || routineResult.kind === "command") return [];
        const argumentTypes = this.#routineCallTypes(candidate, expression);
        if (argumentTypes === undefined) return [];
        return [
          {
            value: candidate,
            argumentTypes,
            resultType:
              routineResult.kind === "scalar" || routineResult.kind === "set"
                ? routineResult.databaseType
                : routineResult.kind,
          },
        ];
      }),
      expression.arguments.map((argument, index) => this.#overloadInputType(argument, argumentsList[index])),
      this.#schema,
    );
    if (result.kind === "selected") {
      return { routine: result.candidate, argumentTypes: result.argumentTypes, resultType: result.resultType };
    }
    if (result.kind === "ambiguous") {
      this.#diagnostic(
        "TSQ204",
        `Ambiguous overloaded table function ${expression.name.name}`,
        expression.range,
        "Cast arguments to select a specific overload.",
      );
    } else if (candidates.length > 0) {
      this.#diagnostic(
        "TSQ202",
        `No table-function overload of ${expression.name.name} accepts these argument types`,
        expression.range,
        "Cast arguments to a supported overload.",
        "warning",
      );
    }
    return undefined;
  }

  #arrayElementType(type: string): string {
    const match = /^readonly \((.*)\)\[\]$/u.exec(type);
    return match?.[1] ?? "unknown";
  }

  #resolveItems(
    items: readonly SelectItem[],
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
    expectedOutput?: readonly (ResolvedType | undefined)[],
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
            ? scope.relations.filter((relation) => relation.qualifiedOnly !== true)
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
      const type = this.#resolveExpression(item.expression, scope, ctes, expectedOutput?.[columns.length]);
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
    if (expression.kind === "subscript") return this.#outputName(expression.expression);
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
        const expectedElement =
          expected?.databaseType === undefined ? undefined : postgresElementType(expected.databaseType, this.#schema);
        const expectedElementType =
          expectedElement === undefined ? undefined : this.#databaseType(expectedElement, expected?.nullable ?? true);
        const elements = expression.elements.map((element) =>
          this.#resolveExpression(element, scope, ctes, expectedElementType),
        );
        const elementType = unionTypeLiterals(elements.map((element) => element.tsType));
        const databaseType =
          (elements.length === 0
            ? undefined
            : postgresCommonType(
                elements.map((element) => element.databaseType),
                this.#schema,
              )) ?? expectedElement;
        return {
          tsType: `readonly (${elementType})[]`,
          nullable: false,
          ...(databaseType === undefined ? {} : { databaseType: `${databaseType}[]` }),
        };
      }
      case "row": {
        const elements = expression.elements.map((element) => this.#resolveExpression(element, scope, ctes));
        return {
          tsType: `readonly [${elements.map((element) => element.tsType + (element.nullable ? " | null" : "")).join(", ")}]`,
          nullable: false,
        };
      }
      case "subscript": {
        const source = this.#resolveExpression(expression.expression, scope, ctes);
        const expectedIndex = this.#databaseType("integer", false);
        const bounds = [expression.index, expression.lower, expression.upper]
          .filter((bound): bound is Expression => bound !== undefined)
          .map((bound) => ({
            expression: bound,
            resolved: this.#resolveExpression(bound, scope, ctes, expectedIndex),
          }));
        for (const bound of bounds) {
          if (
            bound.resolved.databaseType !== undefined &&
            !postgresCanCoerce(bound.resolved.databaseType, "integer", "implicit", this.#schema)
          ) {
            this.#diagnostic(
              "TSQ203",
              `Array subscript must resolve to integer, received ${bound.resolved.databaseType}`,
              bound.expression.range,
            );
          }
        }
        if (expression.slice) {
          if (
            source.databaseType === undefined ||
            postgresElementType(source.databaseType, this.#schema) === undefined
          ) {
            this.#diagnostic(
              "TSQ203",
              `Array slicing requires an array value, received ${source.databaseType ?? source.tsType}`,
              expression.range,
            );
            return { tsType: "unknown", nullable: true };
          }
          return {
            ...source,
            nullable: source.nullable || bounds.some((bound) => bound.resolved.nullable),
          };
        }
        const elementType =
          source.databaseType === "point"
            ? "double precision"
            : source.databaseType === "box" || source.databaseType === "lseg"
              ? "point"
              : source.databaseType === undefined
                ? undefined
                : postgresElementType(source.databaseType, this.#schema);
        if (elementType === undefined) {
          this.#diagnostic(
            "TSQ203",
            `Subscripting requires an array or subscriptable geometric value, received ${source.databaseType ?? source.tsType}`,
            expression.range,
          );
          return { tsType: "unknown", nullable: true };
        }
        return {
          tsType: mapPostgresType(elementType, this.#policy, this.#schema),
          nullable: true,
          databaseType: elementType,
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
        } else if (
          source.databaseType !== undefined &&
          !this.#isUnknownCastSource(expression.expression) &&
          !postgresCanCoerce(source.databaseType, expression.databaseType.name, "explicit", this.#schema)
        ) {
          this.#diagnostic(
            "TSQ230",
            `PostgreSQL has no recorded explicit cast from ${source.databaseType} to ${expression.databaseType.name}`,
            expression.range,
            "Use a supported intermediate type or add exact extension cast evidence.",
          );
        }
        return {
          tsType: mapPostgresType(expression.databaseType.name, this.#policy, this.#schema),
          nullable: source.nullable,
          databaseType: normalizeDatabaseType(expression.databaseType.name),
        };
      }
      case "unary": {
        let operand = this.#resolveExpression(
          expression.expression,
          scope,
          ctes,
          expression.operator === "NOT" ? this.#databaseType("boolean", false) : undefined,
        );
        const operator = resolvePostgresUnaryOperator(
          expression.operator,
          this.#overloadInputType(expression.expression, operand),
          this.#schema,
        );
        if (operator.kind !== "selected") {
          this.#diagnostic(
            "TSQ203",
            `${operator.kind === "ambiguous" ? "Ambiguous" : "No matching"} unary operator ${expression.operator} for ${operand.databaseType ?? operand.tsType}`,
            expression.range,
            operator.kind === "ambiguous" ? "Cast the operand to select a specific overload." : undefined,
          );
          return { tsType: "unknown", nullable: true };
        }
        if (expression.expression.kind === "parameter") {
          operand = this.#resolveExpression(
            expression.expression,
            scope,
            ctes,
            this.#databaseType(operator.argumentTypes[0]!, operand.nullable),
          );
        }
        return {
          tsType: mapPostgresType(operator.resultType, this.#policy, this.#schema),
          nullable: operand.nullable,
          databaseType: operator.resultType,
        };
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
        const resolved = this.#resolveStatement(
          expression.query,
          scope,
          ctes,
          expected === undefined ? undefined : [expected],
        );
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
      case "quantified-comparison": {
        if (expression.left.kind === "row" && expression.right.kind === "select") {
          return this.#resolveQuantifiedRowSubquery(expression, scope, ctes);
        }
        let left = this.#resolveExpression(expression.left, scope, ctes);
        let rightExpression: ResolvedType | undefined;
        let rightType: string | undefined;
        let nullable = left.nullable;
        if (expression.right.kind === "select") {
          const resolved = this.#resolveStatement(expression.right, scope, ctes);
          if (resolved.columns.length !== 1) {
            this.#diagnostic(
              "TSQ217",
              `${expression.quantifier.toUpperCase()} subquery returns ${resolved.columns.length} columns instead of one`,
              expression.range,
            );
          }
          rightType = resolved.columns[0]?.databaseType;
          nullable ||= resolved.columns[0]?.nullable ?? true;
        } else {
          rightExpression = this.#resolveExpression(expression.right, scope, ctes);
          rightType =
            rightExpression.databaseType === undefined
              ? undefined
              : postgresElementType(rightExpression.databaseType, this.#schema);
          if (rightExpression.databaseType !== undefined && rightType === undefined) {
            this.#diagnostic(
              "TSQ203",
              `Quantified comparison requires an array, received ${rightExpression.databaseType}`,
              expression.right.range,
            );
            return { tsType: "unknown", nullable: true };
          }
          nullable = true;
        }
        if (expression.right.kind === "select" && rightType === undefined) {
          this.#diagnostic("TSQ203", "Quantified subquery result type is unknown", expression.right.range);
          return { tsType: "unknown", nullable: true };
        }
        const operator = resolvePostgresOperator(
          expression.operator,
          this.#overloadInputType(expression.left, left),
          rightType,
          this.#schema,
        );
        if (operator.kind !== "selected") {
          this.#diagnostic(
            "TSQ203",
            `${operator.kind === "ambiguous" ? "Ambiguous" : "No matching"} quantified operator ${expression.operator} for ${left.databaseType ?? left.tsType} and ${rightType ?? rightExpression?.databaseType ?? "unknown collection"}`,
            expression.range,
            operator.kind === "ambiguous" ? "Cast the left operand or quantified input." : undefined,
          );
          return { tsType: "unknown", nullable: true };
        }
        if (expression.left.kind === "parameter") {
          left = this.#resolveExpression(
            expression.left,
            scope,
            ctes,
            this.#databaseType(operator.argumentTypes[0]!, left.nullable),
          );
        }
        if (expression.right.kind !== "select") {
          rightExpression = this.#resolveExpression(
            expression.right,
            scope,
            ctes,
            this.#databaseType(`${operator.argumentTypes[1]}[]`, rightExpression?.nullable ?? true),
          );
        }
        return { tsType: "boolean", nullable, databaseType: "boolean" };
      }
      case "in": {
        const subject = this.#resolveExpression(expression.expression, scope, ctes);
        let nullable = subject.nullable;
        if (Array.isArray(expression.values)) {
          const values = expression.values.map((value) => this.#resolveExpression(value, scope, ctes, subject));
          nullable ||= values.some((value) => value.nullable);
        } else {
          const resolved = this.#resolveStatement(expression.values as SelectStatement, scope, ctes, [subject]);
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
    if (expression.left.kind === "row" && expression.right.kind === "row") {
      return this.#resolveRowComparison(expression, scope, ctes);
    }
    if (expression.left.kind === "row" || expression.right.kind === "row") {
      this.#resolveExpression(expression.left, scope, ctes);
      this.#resolveExpression(expression.right, scope, ctes);
      this.#diagnostic("TSQ203", "Row comparison requires a row constructor on both sides", expression.range);
      return { tsType: "unknown", nullable: true };
    }
    let left: ResolvedType;
    let right: ResolvedType;
    if (expression.left.kind === "parameter" && expression.right.kind !== "parameter") {
      right = this.#resolveExpression(expression.right, scope, ctes);
      left = this.#resolveExpression(expression.left, scope, ctes);
    } else {
      left = this.#resolveExpression(expression.left, scope, ctes);
      right = this.#resolveExpression(expression.right, scope, ctes);
    }
    if (expression.operator === "IS" || expression.operator === "IS NOT") {
      return { tsType: "boolean", nullable: false, databaseType: "boolean" };
    }
    const operator = resolvePostgresOperator(
      expression.operator,
      this.#overloadInputType(expression.left, left),
      this.#overloadInputType(expression.right, right),
      this.#schema,
    );
    if (operator.kind === "selected") {
      const invalidNumericLiteral = ([expression.left, expression.right] as const).some((operand, index) => {
        if (operand.kind !== "literal" || typeof operand.value !== "string") return false;
        const target = operator.argumentTypes[index]!;
        if (!this.#isNumericType(target)) return false;
        const integer = ["smallint", "integer", "bigint"].includes(normalizeDatabaseType(target));
        return integer
          ? !/^[+-]?\d+$/u.test(operand.value)
          : !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(operand.value);
      });
      if (invalidNumericLiteral) {
        this.#diagnostic(
          "TSQ203",
          `A string literal is not valid input for the selected ${expression.operator} numeric overload`,
          expression.range,
        );
        return { tsType: "unknown", nullable: true };
      }
      if (expression.left.kind === "parameter") {
        left = this.#resolveExpression(
          expression.left,
          scope,
          ctes,
          this.#databaseType(operator.argumentTypes[0]!, right.nullable),
        );
      }
      if (expression.right.kind === "parameter") {
        right = this.#resolveExpression(
          expression.right,
          scope,
          ctes,
          this.#databaseType(operator.argumentTypes[1]!, left.nullable),
        );
      }
      return {
        tsType: mapPostgresType(operator.resultType, this.#policy, this.#schema),
        nullable: expression.operator.startsWith("IS ") ? false : left.nullable || right.nullable,
        databaseType: operator.resultType,
      };
    }
    this.#diagnostic(
      "TSQ203",
      `${operator.kind === "ambiguous" ? "Ambiguous" : "No matching"} operator ${expression.operator} for ${left.databaseType ?? left.tsType} and ${right.databaseType ?? right.tsType}`,
      expression.range,
      operator.kind === "ambiguous" ? "Cast an operand to select a specific overload." : undefined,
    );
    return { tsType: "unknown", nullable: true };
  }

  #resolveQuantifiedRowSubquery(
    expression: Extract<Expression, { readonly kind: "quantified-comparison" }>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
    const leftRow = expression.left as Extract<Expression, { readonly kind: "row" }>;
    const subquery = expression.right as SelectStatement;
    const resolved = this.#resolveStatement(subquery, scope, ctes);
    if (leftRow.elements.length !== resolved.columns.length) {
      for (const element of leftRow.elements) this.#resolveExpression(element, scope, ctes);
      this.#diagnostic(
        "TSQ217",
        `${expression.quantifier.toUpperCase()} row comparison requires ${leftRow.elements.length} subquery columns, received ${resolved.columns.length}`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    let nullable = false;
    leftRow.elements.forEach((leftExpression, index) => {
      let left = this.#resolveExpression(leftExpression, scope, ctes);
      const right = resolved.columns[index]!;
      const operator = resolvePostgresOperator(
        expression.operator,
        this.#overloadInputType(leftExpression, left),
        right.databaseType,
        this.#schema,
      );
      if (operator.kind !== "selected") {
        this.#diagnostic(
          "TSQ203",
          `${operator.kind === "ambiguous" ? "Ambiguous" : "No matching"} quantified row operator ${expression.operator} for position ${index + 1}`,
          expression.range,
        );
      } else if (leftExpression.kind === "parameter") {
        left = this.#resolveExpression(
          leftExpression,
          scope,
          ctes,
          this.#databaseType(operator.argumentTypes[0]!, left.nullable),
        );
      }
      nullable ||= left.nullable || right.nullable;
    });
    return { tsType: "boolean", nullable, databaseType: "boolean" };
  }

  #resolveRowComparison(
    expression: Extract<Expression, { readonly kind: "binary" }>,
    scope: Scope,
    ctes: ReadonlyMap<string, TableSnapshot>,
  ): ResolvedType {
    const leftRow = expression.left as Extract<Expression, { readonly kind: "row" }>;
    const rightRow = expression.right as Extract<Expression, { readonly kind: "row" }>;
    const supported = ["=", "!=", "<>", "<", "<=", ">", ">=", "IS DISTINCT FROM", "IS NOT DISTINCT FROM"].includes(
      expression.operator,
    );
    if (!supported || leftRow.elements.length !== rightRow.elements.length) {
      for (const element of [...leftRow.elements, ...rightRow.elements]) this.#resolveExpression(element, scope, ctes);
      this.#diagnostic(
        "TSQ203",
        supported
          ? `Row comparison requires equal arity, received ${leftRow.elements.length} and ${rightRow.elements.length}`
          : `PostgreSQL does not support row comparison operator ${expression.operator}`,
        expression.range,
      );
      return { tsType: "unknown", nullable: true };
    }
    let nullable = false;
    leftRow.elements.forEach((leftExpression, index) => {
      const rightExpression = rightRow.elements[index]!;
      let left = this.#resolveExpression(leftExpression, scope, ctes);
      let right = this.#resolveExpression(rightExpression, scope, ctes);
      const operator = resolvePostgresOperator(
        expression.operator,
        this.#overloadInputType(leftExpression, left),
        this.#overloadInputType(rightExpression, right),
        this.#schema,
      );
      if (operator.kind !== "selected") {
        this.#diagnostic(
          "TSQ203",
          `${operator.kind === "ambiguous" ? "Ambiguous" : "No matching"} row operator ${expression.operator} for position ${index + 1}`,
          expression.range,
        );
      } else {
        if (leftExpression.kind === "parameter")
          left = this.#resolveExpression(
            leftExpression,
            scope,
            ctes,
            this.#databaseType(operator.argumentTypes[0]!, left.nullable),
          );
        if (rightExpression.kind === "parameter")
          right = this.#resolveExpression(
            rightExpression,
            scope,
            ctes,
            this.#databaseType(operator.argumentTypes[1]!, right.nullable),
          );
      }
      nullable ||= left.nullable || right.nullable;
    });
    return {
      tsType: "boolean",
      nullable: expression.operator.includes("DISTINCT FROM") ? false : nullable,
      databaseType: "boolean",
    };
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
      if (relation.qualifiedOnly === true) return [];
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
    const aggregateOrder = (expression.orderBy ?? []).map((item) =>
      this.#resolveExpression(item.expression, scope, ctes),
    );
    const withinOrder = (expression.withinGroup ?? []).map((item) =>
      this.#resolveExpression(item.expression, scope, ctes),
    );
    if (expression.filter !== undefined) {
      this.#resolveExpression(expression.filter, scope, ctes, this.#databaseType("boolean", false));
    }
    if ((expression.orderBy?.length ?? 0) > 0 && (expression.withinGroup?.length ?? 0) > 0) {
      this.#diagnostic("TSQ223", "An aggregate cannot use both argument ORDER BY and WITHIN GROUP", expression.range);
    }
    if (expression.over !== undefined) {
      if ("partitionBy" in expression.over) this.#resolveWindowSpecification(expression.over, scope, ctes);
      else if (!scope.windows.has(sqlName(expression.over))) {
        this.#diagnostic("TSQ222", `Unknown window ${expression.over.name}`, expression.over.range);
      }
    }
    const name = expression.name.name.toUpperCase();
    if (name === "MERGE_ACTION" && expression.arguments.length === 0) {
      this.#requireServerMajor(17, "merge_action()", expression.range);
      if (!this.#insideMergeReturning)
        this.#diagnostic("TSQ227", "merge_action() is only valid in MERGE RETURNING", expression.range);
      return { tsType: "string", nullable: false, databaseType: "text" };
    }
    const routineRule = postgresCatalogRoutineRule(name, this.#schema);
    const aggregate = this.#isAggregateCall(expression);
    const windowOnly =
      routineRule === "bigint-window" ||
      routineRule === "double-window" ||
      routineRule === "integer-window" ||
      routineRule === "value-window";
    const hypothetical = (expression.withinGroup?.length ?? 0) > 0 && hypotheticalAggregates.has(name);
    if (
      expression.distinct &&
      (expression.orderBy ?? []).some(
        ({ expression: ordered }) =>
          !expression.arguments.some(
            (argument) => postgresExpressionIdentity(argument) === postgresExpressionIdentity(ordered),
          ),
      )
    ) {
      this.#diagnostic(
        "TSQ227",
        "DISTINCT aggregate ORDER BY expressions must appear in its arguments",
        expression.range,
      );
    }
    if (name === "MODE" && (expression.arguments.length !== 0 || withinOrder.length !== 1)) {
      this.#diagnostic("TSQ227", "MODE requires no direct arguments and one WITHIN GROUP key", expression.range);
    }
    if (
      (name === "PERCENTILE_CONT" || name === "PERCENTILE_DISC") &&
      (expression.arguments.length !== 1 || withinOrder.length !== 1)
    ) {
      this.#diagnostic(
        "TSQ227",
        `${expression.name.name} requires one fraction and one WITHIN GROUP key`,
        expression.range,
      );
    }
    if (hypothetical && (expression.arguments.length === 0 || expression.arguments.length !== withinOrder.length)) {
      this.#diagnostic(
        "TSQ227",
        `${expression.name.name} hypothetical arguments must match its WITHIN GROUP keys`,
        expression.range,
      );
    }
    if (windowOnly && expression.over === undefined && !hypothetical) {
      this.#diagnostic("TSQ223", `${expression.name.name} requires an OVER clause`, expression.range);
    }
    if ((expression.withinGroup?.length ?? 0) > 0 && routineRule !== "ordered-set-value" && !hypothetical) {
      this.#diagnostic("TSQ227", `${expression.name.name} does not accept WITHIN GROUP`, expression.range);
    }
    if (
      expression.over !== undefined &&
      (expression.distinct || (expression.orderBy?.length ?? 0) > 0 || (expression.withinGroup?.length ?? 0) > 0)
    ) {
      this.#diagnostic(
        "TSQ223",
        "Window invocations cannot use DISTINCT, argument ORDER BY, or WITHIN GROUP",
        expression.range,
      );
    }
    if (expression.filter !== undefined && !aggregate) {
      this.#diagnostic("TSQ223", "FILTER is only valid for aggregate functions", expression.filter.range);
    }
    if (expression.distinct && !aggregate) {
      this.#diagnostic("TSQ223", "DISTINCT is only valid for aggregate functions", expression.range);
    }
    if ((expression.orderBy?.length ?? 0) > 0 && !aggregate) {
      this.#diagnostic("TSQ223", "Argument ORDER BY is only valid for aggregate functions", expression.range);
    }
    if (routineRule === "count") return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint" };
    if (routineRule === "bigint-window")
      return { tsType: this.#policy.bigint, nullable: false, databaseType: "bigint" };
    if (routineRule === "double-window") return { tsType: "number", nullable: false, databaseType: "double precision" };
    if (routineRule === "integer-window" || routineRule === "grouping")
      return { tsType: "number", nullable: false, databaseType: "integer" };
    if (routineRule === "value-window") {
      return { ...(resolved[0] ?? { tsType: "unknown" }), nullable: true };
    }
    if (routineRule === "ordered-set-value") {
      if (withinOrder.length === 0) {
        this.#diagnostic("TSQ227", `${expression.name.name} requires WITHIN GROUP`, expression.range);
        return { tsType: "unknown", nullable: true };
      }
      return { ...withinOrder[0]!, nullable: true };
    }
    if (routineRule === "coalesce") {
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
    if (routineRule === "nullif") return { ...(resolved[0] ?? { tsType: "unknown" }), nullable: true };
    if (routineRule === "extrema")
      return {
        ...(resolved[0] ?? { tsType: "unknown", nullable: true }),
        nullable: name === "MIN" || name === "MAX" ? true : resolved.some((result) => result.nullable),
      };
    if (routineRule === "numeric-aggregate")
      return {
        tsType: resolved[0]?.tsType ?? this.#policy.numeric,
        nullable: true,
        databaseType: resolved[0]?.databaseType ?? "numeric",
      };
    if (routineRule === "boolean-aggregate") return { tsType: "boolean", nullable: true, databaseType: "boolean" };
    if (routineRule === "string-aggregate") return { tsType: "string", nullable: true, databaseType: "text" };
    if (routineRule === "json-aggregate")
      return { tsType: this.#policy.json, nullable: true, databaseType: name.startsWith("JSONB") ? "jsonb" : "json" };
    if (routineRule === "array-aggregate") {
      const item = resolved[0] ?? aggregateOrder[0] ?? { tsType: "unknown", nullable: true };
      return {
        tsType: `readonly (${item.tsType}${item.nullable ? " | null" : ""})[]`,
        nullable: true,
        ...(item.databaseType === undefined ? {} : { databaseType: `${item.databaseType}[]` }),
      };
    }

    const functionName = sqlName(expression.name);
    const schemaName = expression.schema === undefined ? undefined : sqlName(expression.schema);
    const routines = this.#index.routineOverloads(functionName, expression.arguments.length, schemaName);
    if (routines.length > 0) {
      const selection = resolvePostgresCandidates(
        routines.flatMap((routine) => {
          const result = routine.result;
          if (result.kind !== "scalar" && result.kind !== "set") return [];
          const argumentTypes = this.#routineCallTypes(routine, expression);
          if (argumentTypes === undefined) return [];
          return [
            {
              value: routine,
              argumentTypes,
              resultType: result.databaseType,
            },
          ];
        }),
        expression.arguments.map((argument, index) => this.#overloadInputType(argument, resolved[index])),
        this.#schema,
      );
      if (selection.kind === "selected") {
        expression.arguments.forEach((argument, index) => {
          if (argument.kind === "parameter") {
            this.#resolveExpression(argument, scope, ctes, this.#databaseType(selection.argumentTypes[index]!, true));
          }
        });
        const result = selection.candidate.result;
        if (result.kind === "scalar" || result.kind === "set") {
          return {
            tsType:
              selection.resultType === normalizeDatabaseType(result.databaseType)
                ? result.tsType
                : mapPostgresType(selection.resultType, this.#policy, this.#schema),
            nullable: result.nullable,
            databaseType: selection.resultType,
          };
        }
      }
      if (selection.kind === "ambiguous") {
        this.#diagnostic(
          "TSQ204",
          `Ambiguous overloaded function ${expression.name.name}`,
          expression.range,
          "Cast arguments to select a specific overload.",
        );
      } else {
        this.#diagnostic(
          "TSQ202",
          `No overload of ${expression.name.name} accepts these argument types`,
          expression.range,
          "Cast arguments to a supported overload.",
          "warning",
        );
      }
      return { tsType: "unknown", nullable: true };
    }
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

  #typesCompatible(
    expected: string,
    actual: string,
    context: "assignment" | "explicit" | "implicit" = "implicit",
  ): boolean {
    return postgresCanCoerce(actual, expected, context, this.#schema);
  }

  #overloadInputType(expression: Expression, resolved: ResolvedType | undefined): string | undefined {
    if (expression.kind === "parameter") return undefined;
    if (expression.kind === "literal" && (expression.value === null || typeof expression.value === "string")) {
      return undefined;
    }
    return resolved?.databaseType;
  }

  #isUnknownCastSource(expression: Expression): boolean {
    return (
      expression.kind === "parameter" ||
      (expression.kind === "literal" && (expression.value === null || typeof expression.value === "string"))
    );
  }

  #routineCallTypes(routine: StructuralRoutineSnapshot, expression: CallExpression): readonly string[] | undefined {
    const inputs = routine.arguments.filter(({ mode }) => mode !== "out");
    const names = expression.argumentNames;
    if (names !== undefined) {
      const used = new Set<number>();
      let positional = 0;
      const mapped = names.map((name): string | undefined => {
        let index: number;
        if (name === undefined) {
          while (used.has(positional)) positional += 1;
          index = positional;
          positional += 1;
        } else {
          index = inputs.findIndex(
            (argument) => argument.name !== undefined && argument.name.toLowerCase() === sqlName(name),
          );
        }
        if (index < 0 || index >= inputs.length || used.has(index)) return undefined;
        used.add(index);
        return inputs[index]!.databaseType;
      });
      if (mapped.some((type) => type === undefined)) return undefined;
      if (
        inputs.some(
          (argument, index) => !used.has(index) && argument.mode !== "variadic" && argument.default !== "present",
        )
      )
        return undefined;
      return mapped as readonly string[];
    }
    const variadic = inputs.at(-1)?.mode === "variadic";
    if (!variadic) {
      if (expression.variadic === true) return undefined;
      if (expression.arguments.length > inputs.length) return undefined;
      if (inputs.slice(expression.arguments.length).some(({ default: defaultValue }) => defaultValue !== "present")) {
        return undefined;
      }
      return inputs.slice(0, expression.arguments.length).map(({ databaseType }) => databaseType);
    }
    const fixed = inputs.slice(0, -1);
    const variadicType = inputs.at(-1)!.databaseType;
    if (expression.variadic === true) {
      if (expression.arguments.length !== inputs.length) return undefined;
      return [...fixed.map(({ databaseType }) => databaseType), variadicType];
    }
    if (
      expression.arguments.length < fixed.length &&
      fixed.slice(expression.arguments.length).some(({ default: defaultValue }) => defaultValue !== "present")
    ) {
      return undefined;
    }
    const elementType = normalizeDatabaseType(variadicType).replace(/\[\]$/u, "");
    if (elementType === normalizeDatabaseType(variadicType)) return undefined;
    return expression.arguments.map((_, index) => (index < fixed.length ? fixed[index]!.databaseType : elementType));
  }

  #isDefaultValue(expression: Expression | undefined): boolean {
    return (
      expression?.kind === "column" &&
      expression.relation === undefined &&
      expression.column.quoted === false &&
      expression.column.name === "DEFAULT"
    );
  }

  #matchConflictInference(
    table: TableSnapshot,
    target: Extract<InsertConflictTarget, { readonly kind: "inference" }>,
  ): boolean | "unknown" {
    const relation = this.#index.relation(table);
    if (relation === undefined) return "unknown";
    const requested: ConflictInferenceElement[] = target.elements.map((element) => ({
      ...(element.expression.kind === "column" && element.expression.relation === undefined
        ? {
            column: sqlName(element.expression.column),
            columnCaseSensitive: element.expression.column.quoted,
          }
        : { expressionHash: fingerprintPostgresExpression(element.expression) }),
      ...(element.operatorClass === undefined
        ? {}
        : {
            operatorClass: qualifiedSqlName(element.operatorClass),
            operatorClassCaseSensitive: qualifiedNameIsCaseSensitive(element.operatorClass),
          }),
      ...(element.collation === undefined
        ? {}
        : {
            collation: qualifiedSqlName(element.collation),
            collationCaseSensitive: qualifiedNameIsCaseSensitive(element.collation),
          }),
    }));
    const predicateHash = target.predicate === undefined ? undefined : fingerprintPostgresExpression(target.predicate);
    let incomplete = false;
    const matchesElements = (candidates: readonly ConflictInferenceElement[]): boolean => {
      if (candidates.length !== requested.length) return false;
      const remaining = [...candidates];
      const matchesNamedEvidence = (candidate: string | undefined, name: string, caseSensitive: boolean): boolean => {
        if (candidate === undefined) return false;
        const candidateName = name.includes(".") ? candidate : candidate.slice(candidate.lastIndexOf(".") + 1);
        return caseSensitive ? candidateName === name : candidateName.toLowerCase() === name;
      };
      for (const element of requested) {
        const index = remaining.findIndex((candidate) => {
          const identityMatches =
            element.column === undefined
              ? candidate.expressionHash === element.expressionHash
              : element.columnCaseSensitive
                ? candidate.column === element.column
                : candidate.column?.toLowerCase() === element.column;
          return (
            identityMatches &&
            (element.operatorClass === undefined ||
              matchesNamedEvidence(
                candidate.operatorClass,
                element.operatorClass,
                element.operatorClassCaseSensitive ?? false,
              )) &&
            (element.collation === undefined ||
              matchesNamedEvidence(candidate.collation, element.collation, element.collationCaseSensitive ?? false))
          );
        });
        if (index < 0) return false;
        remaining.splice(index, 1);
      }
      return true;
    };

    if (relation.indexes === undefined) incomplete = true;
    for (const index of relation.indexes ?? []) {
      if (!index.unique) continue;
      if (index.valid !== true) {
        if (index.valid === "unknown") incomplete = true;
        continue;
      }
      if (target.predicate === undefined) {
        if (index.predicate === "unknown") {
          incomplete = true;
          continue;
        }
        if (index.predicate !== "none") continue;
      } else {
        if (index.predicate === "unknown") {
          incomplete = true;
          continue;
        }
        if (index.predicate === "present" && index.predicateHash === undefined) {
          incomplete = true;
          continue;
        }
        if (index.predicate === "present" && index.predicateHash !== predicateHash && matchesElements(index.columns)) {
          incomplete = true;
          continue;
        }
      }
      if (matchesElements(index.columns)) return true;
      if (
        requested.some(
          (element) => (element.operatorClass?.includes(".") ?? false) || (element.collation?.includes(".") ?? false),
        ) &&
        index.columns.some(
          (column) =>
            (column.operatorClass !== undefined && !column.operatorClass.includes(".")) ||
            (column.collation !== undefined && !column.collation.includes(".")),
        )
      )
        incomplete = true;
      if (index.columns.some((column) => column.column === undefined && column.expressionHash === undefined)) {
        incomplete = true;
      }
    }

    if (requested.every((element) => element.column !== undefined)) {
      const requestedColumns = requested as readonly (ConflictInferenceElement & { readonly column: string })[];
      for (const constraint of relation.constraints) {
        if (
          (constraint.kind !== "primary-key" && constraint.kind !== "unique") ||
          constraint.partial !== false ||
          constraint.expressionBased !== false ||
          constraint.columns.length !== requestedColumns.length ||
          !constraint.columns.every((column) =>
            requestedColumns.some((requestedColumn) =>
              requestedColumn.columnCaseSensitive
                ? column === requestedColumn.column
                : column.toLowerCase() === requestedColumn.column,
            ),
          )
        )
          continue;
        if (constraint.deferrable === false) return true;
        if (constraint.deferrable === "unknown" || constraint.deferrable === undefined) incomplete = true;
      }
    }
    return incomplete ? "unknown" : false;
  }

  #validateWriteColumns(
    targets: readonly (ColumnSnapshot | undefined)[],
    sources: readonly ResolvedColumn[],
    range: SourceRange,
    operation: string,
  ): void {
    for (let index = 0; index < Math.min(targets.length, sources.length); index += 1) {
      this.#validateWriteValue(targets[index], sources[index]!, range, operation);
    }
  }

  #validateWriteValue(
    target: ColumnSnapshot | undefined,
    source: ResolvedType,
    range: SourceRange,
    operation: string,
  ): void {
    if (
      target === undefined ||
      source.databaseType === undefined ||
      source.tsType === "unknown" ||
      this.#typesCompatible(target.databaseType, source.databaseType, "assignment")
    )
      return;
    const expectedTsType = mapPostgresType(target.databaseType, this.#policy, this.#schema);
    const actualTsType = mapPostgresType(source.databaseType, this.#policy, this.#schema);
    if (expectedTsType === actualTsType) return;
    this.#diagnostic(
      "TSQ229",
      `${operation} value of type ${source.databaseType} cannot be assigned to ${target.name} (${target.databaseType})`,
      range,
    );
  }

  #isNumericType(databaseType: string): boolean {
    const mapping = postgresCatalogTypeMapping(databaseType, this.#schema);
    return mapping === "bigint" || mapping === "number" || mapping === "numeric";
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
