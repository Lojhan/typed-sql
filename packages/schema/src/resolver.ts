import type {
  Expression,
  Identifier,
  SelectStatement,
  SourceRange,
  SqlDiagnostic,
  TableReference,
} from "@typed-sql/ast";
import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot, TypePolicy } from "./model.js";
import { defaultPostgresTypePolicy } from "./model.js";
import { isKnownPostgresType, mapPostgresType } from "./type-policy.js";

interface Relation {
  readonly alias: string;
  readonly table: TableSnapshot;
  nullable: boolean;
}

interface ResolvedType {
  readonly tsType: string;
  readonly nullable: boolean;
}

export interface ResolvedColumn extends ResolvedType {
  readonly name: string;
  readonly range: SourceRange;
}

export interface ResolvedQuery {
  readonly columns: readonly ResolvedColumn[];
  readonly diagnostics: readonly SqlDiagnostic[];
}

export interface ResolveOptions {
  readonly typePolicy?: TypePolicy;
  readonly strictExpressions?: boolean;
}

const comparable = new Set(["=", "!=", "<>", "<", "<=", ">", ">=", "IS", "IS NOT", "LIKE", "AND", "OR"]);

function sqlName(identifier: Identifier): string {
  return identifier.quoted ? identifier.name : identifier.name.toLowerCase();
}

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => index);
  for (let column = 1; column <= b.length; column += 1) {
    let diagonal = rows[0]!;
    rows[0] = column;
    for (let row = 1; row <= a.length; row += 1) {
      const above = rows[row]!;
      rows[row] = Math.min(rows[row]! + 1, rows[row - 1]! + 1, diagonal + (a[row - 1] === b[column - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return rows[a.length]!;
}

function suggestion(name: string, candidates: readonly string[]): string | undefined {
  const candidate = [...candidates].sort((a, b) => distance(name, a) - distance(name, b))[0];
  if (candidate === undefined || distance(name, candidate) > Math.max(2, Math.floor(name.length / 2))) return undefined;
  return `Did you mean ${candidate}?`;
}

class Resolver {
  readonly #schema: SchemaSnapshot;
  readonly #policy: TypePolicy;
  readonly #strictExpressions: boolean;
  readonly #relations: Relation[] = [];
  readonly #diagnostics: SqlDiagnostic[] = [];

  constructor(schema: SchemaSnapshot, options: ResolveOptions) {
    this.#schema = schema;
    this.#policy = options.typePolicy ?? defaultPostgresTypePolicy;
    this.#strictExpressions = options.strictExpressions ?? true;
  }

  resolve(statement: SelectStatement): ResolvedQuery {
    if (this.#schema.dialect !== "postgres") this.#diagnostic("TSQ007", `MVP resolver only supports PostgreSQL, not ${this.#schema.dialect}`, statement.range);
    if (statement.from !== undefined) this.#addRelation(statement.from, false);
    for (const join of statement.joins) {
      if (join.kind === "right" || join.kind === "full") for (const relation of this.#relations) relation.nullable = true;
      const relation = this.#addRelation(join.table, join.kind === "left" || join.kind === "full");
      if (relation !== undefined) this.#resolveExpression(join.on);
    }

    const columns: ResolvedColumn[] = [];
    const names = new Set<string>();
    for (const item of statement.columns) {
      const type = this.#resolveExpression(item.expression);
      const name = item.alias?.name ?? (item.expression.kind === "column" ? item.expression.column.name : undefined);
      if (name === undefined) {
        if (this.#strictExpressions) this.#diagnostic("TSQ104", "Expressions in SELECT require an explicit alias", item.range, "Add AS <name>.");
        continue;
      }
      if (names.has(name)) {
        this.#diagnostic("TSQ105", `Duplicate output property ${name}`, item.range, "Give one expression a unique alias.");
        continue;
      }
      names.add(name);
      columns.push({ name, tsType: type.tsType, nullable: type.nullable, range: item.range });
    }
    return { columns, diagnostics: this.#diagnostics };
  }

  #addRelation(reference: TableReference, nullable: boolean): Relation | undefined {
    const requested = sqlName(reference.name);
    const requestedSchema = reference.schema === undefined ? undefined : sqlName(reference.schema);
    const tableEntries = Object.entries(this.#schema.tables).filter(([key, table]) => {
      const nameMatches = key.toLowerCase() === requested || key.toLowerCase().endsWith(`.${requested}`) || table.name.toLowerCase() === requested;
      const schemaMatches = requestedSchema === undefined || table.schema?.toLowerCase() === requestedSchema || key.toLowerCase() === `${requestedSchema}.${requested}`;
      return nameMatches && schemaMatches;
    });
    if (tableEntries.length === 0) {
      this.#diagnostic("TSQ100", `Unknown table ${reference.name.name}`, reference.name.range, suggestion(requested, Object.keys(this.#schema.tables)));
      return undefined;
    }
    if (requestedSchema === undefined && tableEntries.length > 1) {
      this.#diagnostic("TSQ107", `Ambiguous table ${reference.name.name}`, reference.name.range, "Qualify the table with a schema name.");
      return undefined;
    }
    const relation: Relation = { alias: reference.alias === undefined ? requested : sqlName(reference.alias), table: tableEntries[0]![1], nullable };
    this.#relations.push(relation);
    return relation;
  }

  #resolveExpression(expression: Expression): ResolvedType {
    switch (expression.kind) {
      case "column": return this.#resolveColumn(expression.relation, expression.column);
      case "literal": {
        if (expression.value === null) return { tsType: "unknown", nullable: true };
        return { tsType: typeof expression.value, nullable: false };
      }
      case "parameter": return { tsType: "unknown", nullable: true };
      case "star": return { tsType: "unknown", nullable: false };
      case "cast": {
        const source = this.#resolveExpression(expression.expression);
        if (!isKnownPostgresType(expression.databaseType.name, this.#schema)) {
          this.#diagnostic("TSQ106", `Invalid or unknown PostgreSQL cast type ${expression.databaseType.name}`, expression.databaseType.range);
        }
        return { tsType: mapPostgresType(expression.databaseType.name, this.#policy, this.#schema), nullable: source.nullable };
      }
      case "unary": {
        const operand = this.#resolveExpression(expression.expression);
        return expression.operator === "NOT" ? { tsType: "boolean", nullable: operand.nullable } : operand;
      }
      case "binary": {
        const left = this.#resolveExpression(expression.left);
        const right = this.#resolveExpression(expression.right);
        if (comparable.has(expression.operator)) return { tsType: "boolean", nullable: expression.operator.startsWith("IS") ? false : left.nullable || right.nullable };
        const tsType = left.tsType === right.tsType ? left.tsType : left.tsType === "number" || right.tsType === "number" ? "number" : `${left.tsType} | ${right.tsType}`;
        return { tsType, nullable: left.nullable || right.nullable };
      }
      case "call": return this.#resolveCall(expression.name, expression.arguments, expression.range);
      case "case": {
        const results = expression.branches.map((branch) => this.#resolveExpression(branch.then));
        if (expression.elseExpression !== undefined) results.push(this.#resolveExpression(expression.elseExpression));
        const types = [...new Set(results.map((result) => result.tsType))];
        return { tsType: types.join(" | ") || "unknown", nullable: expression.elseExpression === undefined || results.some((result) => result.nullable) };
      }
    }
  }

  #resolveColumn(relationIdentifier: Identifier | undefined, columnIdentifier: Identifier): ResolvedType {
    const columnName = sqlName(columnIdentifier);
    let matches: readonly Relation[];
    if (relationIdentifier !== undefined) {
      const alias = sqlName(relationIdentifier);
      const relation = this.#relations.find((candidate) => candidate.alias === alias);
      if (relation === undefined) {
        this.#diagnostic("TSQ103", `Unknown relation alias ${relationIdentifier.name}`, relationIdentifier.range, suggestion(alias, this.#relations.map((item) => item.alias)));
        return { tsType: "unknown", nullable: true };
      }
      matches = [relation];
    } else {
      if (this.#relations.length === 0 && this.#diagnostics.some((diagnostic) => diagnostic.code === "TSQ100")) {
        return { tsType: "unknown", nullable: true };
      }
      matches = this.#relations.filter((relation) => this.#findColumn(relation.table, columnName) !== undefined);
      if (matches.length > 1) {
        this.#diagnostic("TSQ102", `Ambiguous column ${columnIdentifier.name}`, columnIdentifier.range, "Qualify the column with a table alias.");
        return { tsType: "unknown", nullable: true };
      }
    }
    const relation = matches[0];
    const column = relation === undefined ? undefined : this.#findColumn(relation.table, columnName);
    if (column === undefined) {
      const candidates = relation === undefined
        ? this.#relations.flatMap((item) => Object.keys(item.table.columns))
        : Object.keys(relation.table.columns);
      this.#diagnostic("TSQ101", `Unknown column ${columnIdentifier.name}`, columnIdentifier.range, suggestion(columnName, candidates));
      return { tsType: "unknown", nullable: true };
    }
    return { tsType: column.tsType, nullable: column.nullable || relation!.nullable };
  }

  #findColumn(table: TableSnapshot, name: string): ColumnSnapshot | undefined {
    return Object.entries(table.columns).find(([key, column]) => key.toLowerCase() === name || column.name.toLowerCase() === name)?.[1];
  }

  #resolveCall(nameIdentifier: Identifier, args: readonly Expression[], range: SourceRange): ResolvedType {
    const name = nameIdentifier.name.toUpperCase();
    const resolved = args.map((argument) => this.#resolveExpression(argument));
    if (name === "COUNT") return { tsType: this.#policy.bigint, nullable: false };
    if (name === "COALESCE") {
      const types = [...new Set(resolved.map((result) => result.tsType).filter((type) => type !== "unknown"))];
      return { tsType: types.join(" | ") || "unknown", nullable: resolved.every((result) => result.nullable) };
    }
    if (name === "MIN" || name === "MAX") return { tsType: resolved[0]?.tsType ?? "unknown", nullable: true };
    if (name === "SUM") return { tsType: resolved[0]?.tsType ?? this.#policy.numeric, nullable: true };
    const declared = this.#schema.functions?.[nameIdentifier.name]
      ?? this.#schema.functions?.[nameIdentifier.name.toLowerCase()]
      ?? Object.values(this.#schema.functions ?? {}).find((candidate) =>
        candidate.name.toLowerCase() === nameIdentifier.name.toLowerCase() && candidate.argumentTypes.length === args.length,
      );
    if (declared !== undefined) return { tsType: declared.returnType, nullable: declared.nullable };
    this.#diagnostic("TSQ202", `Unknown function ${nameIdentifier.name}`, range, undefined, "warning");
    return { tsType: "unknown", nullable: true };
  }

  #diagnostic(code: string, message: string, range: SourceRange, suggestionText?: string, severity: SqlDiagnostic["severity"] = "error"): void {
    this.#diagnostics.push({ code, message, range, severity, ...(suggestionText === undefined ? {} : { suggestion: suggestionText }) });
  }
}

export function resolveSelect(statement: SelectStatement, schema: SchemaSnapshot, options: ResolveOptions = {}): ResolvedQuery {
  return new Resolver(schema, options).resolve(statement);
}

export function rowTypeLiteral(columns: readonly ResolvedColumn[]): string {
  const properties = columns.map((column) => `${JSON.stringify(column.name)}: ${column.tsType}${column.nullable ? " | null" : ""};`);
  return `{ ${properties.join(" ")} }`;
}
