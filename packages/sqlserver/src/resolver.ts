import {
  brandBaseType,
  type DialectAnalysis,
  type JsonShape,
  type JsonValueDescriptor,
  jsonShapeType,
  type ResolvedColumn,
  type ResolvedParameter,
  type RuntimeValueType,
  type SourceRange,
  type SqlDiagnostic,
  unionJsonShapes,
} from "@typed-sql/core";
import type { ColumnSnapshot, RelationSnapshot, SchemaSnapshot } from "@typed-sql/schema";
import { SQLSERVER_BUILTINS, SQLSERVER_DATEPARTS } from "./catalog/index.js";
import { parseSqlServerNativeType, type SqlServerNativeType } from "./native-types.js";
import type { Cte, Expression, Join, Name, Output, Projection, Select, Source, Statement } from "./parser/index.js";
import { walkExpression, walkStatement } from "./parser/index.js";
import {
  defaultSqlServerTypePolicy,
  mapSqlServerType,
  type SqlServerTypePolicy,
  sqlServerRuntimeValueType,
} from "./type-policy.js";

interface Value {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
  readonly runtimeType?: RuntimeValueType;
  readonly hidden?: boolean;
  readonly predicate?: true;
  readonly jsonFragment?: boolean;
  readonly sqlNull?: true;
  readonly json?: JsonValueDescriptor;
}
interface Relation {
  readonly catalog?: RelationSnapshot;
  readonly qualifiers: readonly string[];
  readonly columns: readonly (Value & { readonly name: string })[];
  readonly key: string;
}
interface Scope {
  readonly relations: readonly Relation[];
  readonly outer?: Scope;
}
type Ctes = ReadonlyMap<string, Relation>;
const unknown: Value = Object.freeze({ tsType: "unknown", nullable: true });
const bool: Value = Object.freeze({ tsType: "boolean", nullable: false, databaseType: "bit" });
const condition: Value = Object.freeze({ ...bool, predicate: true });
const numericNames = new Set([
  "tinyint",
  "smallint",
  "int",
  "bigint",
  "decimal",
  "money",
  "smallmoney",
  "real",
  "float",
]);
const comparison = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "!<", "!>", "LIKE", "NOT LIKE"]);
const precedence = [
  "binary",
  "varbinary",
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "uniqueidentifier",
  "bit",
  "tinyint",
  "smallint",
  "int",
  "bigint",
  "smallmoney",
  "money",
  "decimal",
  "real",
  "float",
  "time",
  "date",
  "smalldatetime",
  "datetime",
  "datetime2",
  "datetimeoffset",
  "xml",
  "json",
  "sql_variant",
];
function type(name: string, nullable = false, policy: SqlServerTypePolicy = defaultSqlServerTypePolicy): Value {
  return {
    tsType: mapSqlServerType(name, policy),
    nullable,
    databaseType: parseSqlServerNativeType(name)?.text ?? name,
    ...(parseSqlServerNativeType(name)?.name === "json"
      ? {
          json: {
            shape: { kind: "unknown" as const },
            representation: policy.json === "parsed" ? ("parsed" as const) : ("text" as const),
          },
          jsonFragment: true,
        }
      : {}),
  };
}
function partsLast(name: Name): string {
  return name.parts.at(-1)!;
}
function native(value: Value): SqlServerNativeType | undefined {
  return value.databaseType ? parseSqlServerNativeType(value.databaseType) : undefined;
}
function runtime(value: Value, policy: SqlServerTypePolicy): RuntimeValueType {
  return value.runtimeType ?? sqlServerRuntimeValueType(value, policy);
}
function decimalDimensions(value: SqlServerNativeType): readonly [number, number] {
  switch (value.name) {
    case "decimal":
      return [value.precision!, value.scale!];
    case "money":
      return [19, 4];
    case "smallmoney":
      return [10, 4];
    case "bigint":
      return [19, 0];
    case "int":
      return [10, 0];
    case "smallint":
      return [5, 0];
    case "tinyint":
      return [3, 0];
    default:
      return [38, 0];
  }
}
function decimalType(
  precision: number,
  scale: number,
  nullable: boolean,
  policy: SqlServerTypePolicy,
  product = false,
): Value {
  if (precision > 38) {
    const integral = precision - scale;
    scale = product && integral >= 32 ? Math.min(scale, 6) : Math.max(0, scale - (precision - 38));
    precision = 38;
  }
  return type(`decimal(${Math.max(1, precision)},${Math.max(0, Math.min(scale, precision))})`, nullable, policy);
}
function numericConstant(expression: Expression): number | undefined {
  if (expression.kind === "literal" && expression.literal === "number") {
    const value = Number(expression.value);
    return Number.isFinite(value) ? value : undefined;
  }
  if (expression.kind === "unary" && ["+", "-"].includes(expression.operator)) {
    const value = numericConstant(expression.argument);
    return value === undefined ? undefined : expression.operator === "-" ? -value : value;
  }
  return undefined;
}
export interface ResolveSqlServerOptions {
  readonly typePolicy?: SqlServerTypePolicy;
  readonly runtimeValidation?: boolean;
}
class Resolver {
  readonly diagnostics: SqlDiagnostic[] = [];
  readonly parameters = new Map<number, ResolvedParameter>();
  readonly #parameterFailures = new Set<number>();
  #depth = 0;
  readonly policy: SqlServerTypePolicy;
  readonly #caseSensitive: boolean;
  readonly #accentSensitive: boolean;
  constructor(
    readonly schema: SchemaSnapshot,
    readonly options: ResolveSqlServerOptions,
  ) {
    this.policy = options.typePolicy ?? defaultSqlServerTypePolicy;
    const collation = String(schema.server?.settings.collation ?? "Latin1_General_100_CS_AS");
    this.#caseSensitive = !/_CI_/iu.test(collation);
    this.#accentSensitive = !/_AI(?:_|$)/iu.test(collation);
  }
  key(value: string): string {
    let result = this.#caseSensitive ? value : value.toLowerCase();
    if (!this.#accentSensitive) result = result.normalize("NFD").replace(/\p{M}/gu, "");
    return result;
  }
  same(left: string, right: string): boolean {
    return this.key(left) === this.key(right);
  }
  diagnostic(code: string, message: string, range: SourceRange): void {
    this.diagnostics.push({ code, message, range, severity: "error" });
  }
  scalar(value: Value, expression: Expression): Value {
    if (value.predicate)
      this.diagnostic("TSQ201", "T-SQL conditions cannot be used as scalar values; use CASE or IIF", expression.range);
    return value;
  }
  expected(expression: Expression, expected: Value, scope: Scope, ctes: Ctes): Value {
    return this.scalar(this.expression(expression, scope, ctes, expected), expression);
  }
  parameter(expression: Expression & { kind: "parameter" }, expected?: Value): Value {
    if (this.#parameterFailures.has(expression.index)) return unknown;
    const current = this.parameters.get(expression.index);
    const candidate = expected?.tsType !== "unknown" ? expected : undefined;
    if (candidate) {
      if (
        current &&
        current.tsType !== "unknown" &&
        (current.tsType !== candidate.tsType ||
          current.databaseType !== candidate.databaseType ||
          JSON.stringify(current.json) !== JSON.stringify(candidate.json))
      ) {
        this.parameters.set(expression.index, { index: expression.index, tsType: "unknown", nullable: true });
        this.#parameterFailures.add(expression.index);
        this.diagnostic(
          "TSQ204",
          `Parameter ${expression.index} has incompatible native SQL Server targets`,
          expression.range,
        );
        return unknown;
      }
      const result = {
        index: expression.index,
        ...candidate,
        ...(candidate.json ? { jsonFragment: native(candidate)?.name === "json" } : {}),
        nullable: candidate.nullable || (current?.tsType !== "unknown" && current?.nullable === true),
        runtimeType: runtime(candidate, this.policy),
      };
      this.parameters.set(expression.index, result);
      return result;
    }
    if (!current) this.parameters.set(expression.index, { index: expression.index, ...unknown });
    return current ?? unknown;
  }
  column(name: Name, scope: Scope): Value {
    const target = partsLast(name);
    const qualifier = name.parts.slice(0, -1).join(".");
    const matches = scope.relations.flatMap((relation) =>
      qualifier && !relation.qualifiers.some((value) => this.same(value, qualifier))
        ? []
        : relation.columns.filter((column) => this.same(column.name, target)),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      this.diagnostic("TSQ102", `Ambiguous column ${name.parts.join(".")}`, name.range);
      return unknown;
    }
    if (scope.outer) return this.column(name, scope.outer);
    this.diagnostic("TSQ101", `Unknown column ${name.parts.join(".")}`, name.range);
    return unknown;
  }
  columnValue(column: ColumnSnapshot): Value {
    const original = parseSqlServerNativeType(column.databaseType);
    const structural = "collation" in column && typeof column.collation === "string" ? column.collation : undefined;
    const collation =
      structural ??
      (typeof this.schema.server?.settings.collation === "string" ? this.schema.server.settings.collation : undefined);
    const databaseType =
      original &&
      !original.collation &&
      ["varchar", "char", "nvarchar", "nchar", "text", "ntext"].includes(original.name) &&
      collation
        ? `${original.text} COLLATE ${collation}`
        : column.databaseType;
    const mapped = type(databaseType, column.nullable, this.policy);
    if (
      "extension" in column &&
      column.extension &&
      typeof column.extension === "object" &&
      "attributes" in column.extension &&
      (column.extension.attributes as Record<string, unknown>).encrypted === true
    )
      return { ...unknown, tsType: this.policy.unknown };
    const branded = brandBaseType(column.tsType);
    return {
      ...mapped,
      ...(branded && branded === mapped.tsType ? { tsType: column.tsType, runtimeType: branded } : {}),
      ...(column.jsonDeclaration
        ? {
            json: {
              shape: column.jsonDeclaration.shape,
              representation: this.policy.json === "parsed" ? ("parsed" as const) : ("text" as const),
            },
            tsType: this.policy.json === "parsed" ? this.jsonType(column.jsonDeclaration.shape) : "string",
            jsonFragment: original?.name === "json",
          }
        : {}),
    };
  }
  relation(name: Name, ctes: Ctes): Relation {
    if (name.parts.length === 1) {
      const cte = [...ctes.entries()].find(([key]) => this.same(key, name.parts[0]!));
      if (cte) return cte[1];
    }
    if (name.parts.length > 3) {
      this.diagnostic("TSQ108", "Linked-server relations require explicit external schema evidence", name.range);
      return { qualifiers: [], columns: [], key: name.parts.join(".") };
    }
    if (
      name.parts.length === 3 &&
      !this.same(String(this.schema.server?.settings.databaseName ?? ""), name.parts[0]!)
    ) {
      this.diagnostic("TSQ108", "Cross-database relation requires matching catalog evidence", name.range);
      return { qualifiers: [], columns: [], key: name.parts.join(".") };
    }
    const tableName = partsLast(name);
    const schemaName =
      name.parts.length > 1 ? name.parts.at(-2) : String(this.schema.server?.settings.defaultSchema ?? "dbo");
    const matches = Object.entries(this.schema.tables).filter(
      ([, table]) => this.same(table.name, tableName) && this.same(table.schema ?? "dbo", schemaName!),
    );
    if (matches.length !== 1) {
      this.diagnostic(
        matches.length ? "TSQ102" : "TSQ100",
        `${matches.length ? "Ambiguous" : "Unknown"} table ${name.parts.join(".")}`,
        name.range,
      );
      return { qualifiers: [], columns: [], key: name.parts.join(".") };
    }
    const [key, table] = matches[0]!;
    const catalog = this.schema.formatVersion === 2 ? this.schema.relations[key] : undefined;
    return {
      key,
      ...(catalog ? { catalog } : {}),
      qualifiers: [
        table.name,
        `${table.schema ?? "dbo"}.${table.name}`,
        ...(name.parts.length === 3 ? [name.parts.join(".")] : []),
      ],
      columns: Object.values(catalog?.columns ?? table.columns).map((column) => ({
        ...this.columnValue(column),
        name: column.name,
        ...("classification" in column && column.classification === "hidden" ? { hidden: true } : {}),
      })),
    };
  }
  validateRoutineQualification(name: Name): void {
    if (
      name.parts.length > 3 ||
      (name.parts.length === 3 && !this.same(name.parts[0]!, String(this.schema.server?.settings.databaseName ?? "")))
    )
      this.diagnostic(
        "TSQ108",
        "Cross-database or linked-server functions require matching catalog evidence",
        name.range,
      );
  }
  source(source: Source, scope: Scope, ctes: Ctes, allowCorrelation: boolean): Relation {
    if (source.kind === "table") {
      const relation = this.relation(source.name, ctes);
      if (source.systemTime) {
        this.expected(source.systemTime, type("datetime2(7)", false, this.policy), scope, ctes);
        if (relation.catalog?.extension?.attributes?.temporalType !== 2)
          this.diagnostic("TSQ203", "FOR SYSTEM_TIME requires qualified system-versioned table evidence", source.range);
      }
      return { ...relation, qualifiers: source.alias ? [source.alias] : relation.qualifiers };
    }
    if (source.kind === "derived") {
      if (new Set(source.columns.map((name) => this.key(name))).size !== source.columns.length)
        this.diagnostic("TSQ203", "Derived table column aliases must be unique", source.range);
      const columns = this.select(
        source.query,
        ctes,
        allowCorrelation ? scope : scope.outer,
        source.columns.length > 0,
      );
      if (source.columns.length && source.columns.length !== columns.length)
        this.diagnostic("TSQ203", "Derived table column alias count does not match projection", source.range);
      return {
        key: source.alias,
        qualifiers: [source.alias],
        columns: columns.map((column, index) => ({ ...column, name: source.columns[index] ?? column.name })),
      };
    }
    this.validateRoutineQualification(source.call.name);
    const name = partsLast(source.call.name).toUpperCase();
    let columns: Relation["columns"] = [];
    if (source.call.name.parts.length === 1 && name === "OPENJSON") {
      if (source.call.arguments.length < 1 || source.call.arguments.length > 2)
        this.diagnostic("TSQ202", "OPENJSON expects one document and optional path", source.call.range);
      const input = source.call.arguments[0];
      if (input) this.expected(input, type("nvarchar(max)", true, this.policy), scope, ctes);
      if (source.call.arguments[1])
        this.expected(source.call.arguments[1], type("nvarchar(4000)", false, this.policy), scope, ctes);
      const level = this.schema.server?.settings.compatibilityLevel;
      if (typeof level === "number" && level < 130)
        this.diagnostic("TSQ401", "OPENJSON requires compatibility level 130 or later", source.range);
      for (const field of source.shape ?? [])
        if (field.json && parseSqlServerNativeType(field.databaseType)?.text !== "nvarchar(max)")
          this.diagnostic("TSQ201", "OPENJSON AS JSON columns require nvarchar(max)", source.range);
      columns = source.shape
        ? source.shape.map((field) => ({
            name: field.name,
            ...type(field.databaseType, true, this.policy),
            ...(field.json
              ? {
                  json: {
                    shape: { kind: "unknown" as const },
                    representation: this.policy.json === "parsed" ? ("parsed" as const) : ("text" as const),
                  },
                  tsType: this.policy.json === "parsed" ? "JsonValue" : "string",
                }
              : {}),
          }))
        : [
            { name: "key", ...type("nvarchar(4000)", false, this.policy) },
            { name: "value", ...type("nvarchar(max)", true, this.policy) },
            { name: "type", ...type("int", false, this.policy) },
          ];
    } else if (source.call.name.parts.length === 1 && name === "STRING_SPLIT") {
      if (source.call.arguments.length < 2 || source.call.arguments.length > 3)
        this.diagnostic(
          "TSQ202",
          "STRING_SPLIT expects string, separator and optional ordinal flag",
          source.call.range,
        );
      const args = source.call.arguments.map((value) => this.expression(value, scope, ctes));
      if (source.call.arguments[0]?.kind === "parameter")
        args[0] = this.expected(source.call.arguments[0], type("nvarchar(max)", true, this.policy), scope, ctes);
      if (source.call.arguments[1])
        this.expected(source.call.arguments[1], type("nchar(1)", false, this.policy), scope, ctes);
      columns = [
        {
          name: "value",
          ...(args[0]?.databaseType ? args[0] : type("nvarchar(max)", true, this.policy))!,
          nullable: true,
        },
      ];
      if (source.call.arguments[2]) {
        const flag = source.call.arguments[2];
        if (flag.kind !== "literal" || flag.literal !== "number" || !["0", "1"].includes(String(flag.value)))
          this.diagnostic("TSQ203", "STRING_SPLIT ordinal flag must be constant 0 or 1", flag.range);
        if (flag.kind === "literal" && String(flag.value) === "1") {
          this.requireVersion(16, source.range, "STRING_SPLIT ordinal");
          columns = [...columns, { name: "ordinal", ...type("bigint", false, this.policy) }];
        }
      }
    } else {
      const routines =
        this.schema.formatVersion === 2
          ? Object.values(this.schema.routines)
              .flat()
              .filter(
                (r) =>
                  this.same(r.name, partsLast(source.call.name)) &&
                  r.kind === "function" &&
                  r.result.kind === "table" &&
                  this.same(
                    r.schema ?? "dbo",
                    source.call.name.parts.at(-2) ?? String(this.schema.server?.settings.defaultSchema ?? "dbo"),
                  ) &&
                  r.arguments.length === source.call.arguments.length &&
                  r.arguments.every((argument) => argument.mode === "in"),
              )
          : [];
      const routine = routines.length === 1 ? routines[0] : undefined;
      if (!routine) {
        this.diagnostic("TSQ105", `Unknown table-valued function ${source.call.name.parts.join(".")}`, source.range);
      } else {
        source.call.arguments.forEach((argument, index) => {
          const target = routine.arguments[index];
          this.scalar(
            this.expression(argument, scope, ctes, target ? type(target.databaseType, true, this.policy) : undefined),
            argument,
          );
        });
        if (routine.result.kind === "table")
          columns = Object.values(routine.result.columns).map((column) => ({
            name: column.name,
            ...type(column.databaseType, column.nullable, this.policy),
          }));
      }
    }
    if (source.columns.length && source.columns.length !== columns.length)
      this.diagnostic("TSQ203", "Function column aliases disagree with result width", source.range);
    return {
      key: source.alias ?? name,
      qualifiers: [source.alias ?? partsLast(source.call.name)],
      columns: columns.map((column, index) => ({ ...column, name: source.columns[index] ?? column.name })),
    };
  }
  requireVersion(major: number, range: SourceRange, feature: string, compatibility?: number): void {
    const actual = Number(this.schema.server?.versionKey);
    if (Number.isFinite(actual) && actual < major)
      this.diagnostic("TSQ401", `${feature} requires SQL Server engine major ${major}`, range);
    const level = this.schema.server?.settings.compatibilityLevel;
    if (compatibility && typeof level === "number" && level < compatibility)
      this.diagnostic("TSQ401", `${feature} requires compatibility level ${compatibility}`, range);
  }
  buildScope(from: Source | undefined, joins: readonly Join[], ctes: Ctes, outer?: Scope): Scope {
    let relations: Relation[] = [];
    if (from) relations.push(this.source(from, { relations: [], ...(outer ? { outer } : {}) }, ctes, false));
    for (const join of joins) {
      const current: Scope = { relations, ...(outer ? { outer } : {}) };
      let relation = this.source(join.source, current, ctes, join.kind.endsWith("apply"));
      if (join.on) this.predicate(join.on, { relations: [...relations, relation], ...(outer ? { outer } : {}) }, ctes);
      if (["right", "full"].includes(join.kind))
        relations = relations.map((value) => ({
          ...value,
          columns: value.columns.map((column) => ({ ...column, nullable: true })),
        }));
      if (["left", "full", "outer-apply"].includes(join.kind))
        relation = { ...relation, columns: relation.columns.map((column) => ({ ...column, nullable: true })) };
      if (
        relations.some((value) =>
          relation.qualifiers.some((name) => value.qualifiers.some((other) => this.same(name, other))),
        )
      )
        this.diagnostic("TSQ102", "Duplicate relation alias", join.range);
      relations.push(relation);
    }
    return { relations, ...(outer ? { outer } : {}) };
  }
  predicate(expression: Expression, scope: Scope, ctes: Ctes): Value {
    const value = this.expression(expression, scope, ctes);
    if (!value.predicate)
      this.diagnostic(
        "TSQ201",
        "T-SQL predicates require comparisons or Boolean conditions; BIT is not a predicate",
        expression.range,
      );
    return value;
  }
  common(left: Value, right: Value, range: SourceRange, nullable = left.nullable || right.nullable): Value {
    const result = { ...this.commonNative(left, right, range, nullable) };
    delete result.json;
    delete result.jsonFragment;
    if (!left.sqlNull || !right.sqlNull) delete result.sqlNull;
    const leftShape = left.json?.shape,
      rightShape = right.json?.shape;
    const shape = left.sqlNull
      ? rightShape
      : right.sqlNull
        ? leftShape
        : leftShape && rightShape
          ? unionJsonShapes([leftShape, rightShape])
          : undefined;
    const nativeJson = native(result)?.name === "json";
    if (shape || nativeJson) {
      const actual = shape ?? { kind: "unknown" as const };
      return {
        ...result,
        tsType: this.policy.json === "parsed" ? this.jsonType(actual) : "string",
        json: { shape: actual, representation: this.policy.json === "parsed" ? "parsed" : "text" },
        ...(nativeJson ? { jsonFragment: true } : {}),
      };
    }
    if (left.json || right.json) return { ...result, tsType: mapSqlServerType(result.databaseType ?? "", this.policy) };
    return result;
  }
  commonNative(left: Value, right: Value, range: SourceRange, nullable = left.nullable || right.nullable): Value {
    if (left.tsType === "unknown" && left.databaseType === undefined) return { ...right, nullable };
    if (right.tsType === "unknown" && right.databaseType === undefined) return { ...left, nullable };
    const a = native(left),
      b = native(right);
    if (!a || !b) {
      this.diagnostic("TSQ201", "Cannot prove a common SQL Server native type", range);
      return unknown;
    }
    if (a.collation && b.collation && a.collation.toLowerCase() !== b.collation.toLowerCase()) {
      this.diagnostic(
        "TSQ201",
        "Implicit text expressions have conflicting native collations; use an explicit qualified conversion",
        range,
      );
      return unknown;
    }
    const collation = a.collation ?? b.collation;
    if (a.name === b.name) {
      if (a.name === "decimal") {
        const p = Math.max(a.precision! - a.scale!, b.precision! - b.scale!) + Math.max(a.scale!, b.scale!);
        return decimalType(p, Math.max(a.scale!, b.scale!), nullable, this.policy);
      }
      if (a.length !== undefined && b.length !== undefined) {
        const length = a.length === "max" || b.length === "max" ? "max" : Math.max(a.length, b.length);
        return type(
          `${a.name}(${length})${collation && ["char", "varchar", "nchar", "nvarchar"].includes(a.name) ? ` COLLATE ${collation}` : ""}`,
          nullable,
          this.policy,
        );
      }
      return { ...left, nullable };
    }
    const rankA = precedence.indexOf(a.name),
      rankB = precedence.indexOf(b.name);
    if (rankA < 0 || rankB < 0) {
      this.diagnostic("TSQ201", "Unsupported SQL Server implicit type conversion", range);
      return unknown;
    }
    if ((a.name === "xml" || b.name === "xml") && a.name !== b.name) {
      this.diagnostic("TSQ201", "XML coercion requires an explicit CAST", range);
      return unknown;
    }
    if (
      (a.name === "decimal" || b.name === "decimal") &&
      numericNames.has(a.name) &&
      numericNames.has(b.name) &&
      !["float", "real"].includes(a.name) &&
      !["float", "real"].includes(b.name)
    ) {
      const [ap, as] = decimalDimensions(a),
        [bp, bs] = decimalDimensions(b);
      return decimalType(Math.max(ap - as, bp - bs) + Math.max(as, bs), Math.max(as, bs), nullable, this.policy);
    }
    return { ...(rankA > rankB ? left : right), nullable };
  }
  jsonType(shape: JsonShape): string {
    const result = jsonShapeType(shape);
    return result === "unknown" ? "JsonValue" : result;
  }
  shape(value: Value): JsonShape {
    if (value.sqlNull) return { kind: "null" };
    const nativeType = native(value),
      name = nativeType?.name;
    let shape: JsonShape;
    if (value.json) {
      shape =
        value.jsonFragment === true || name === "json"
          ? value.json.shape
          : value.jsonFragment === false
            ? { kind: "string" }
            : { kind: "unknown" };
    } else if (name === "json") shape = { kind: "unknown" };
    else if (name && numericNames.has(name) && !["money", "smallmoney"].includes(name)) shape = { kind: "number" };
    else if (name === "bit") shape = { kind: "boolean" };
    else if (
      name &&
      [
        "date",
        "time",
        "datetime",
        "datetime2",
        "datetimeoffset",
        "smalldatetime",
        "binary",
        "varbinary",
        "image",
        "rowversion",
        "uniqueidentifier",
        "money",
        "smallmoney",
        "char",
        "varchar",
        "nchar",
        "nvarchar",
        "text",
        "ntext",
      ].includes(name)
    )
      shape = { kind: "string" };
    else {
      const base = brandBaseType(value.tsType) ?? value.tsType;
      shape =
        base === "string"
          ? { kind: "string" }
          : base === "number" || base === "bigint"
            ? { kind: "number" }
            : base === "boolean"
              ? { kind: "boolean" }
              : { kind: "unknown" };
    }
    return value.nullable ? unionJsonShapes([shape, { kind: "null" }]) : shape;
  }
  expression(expression: Expression, scope: Scope, ctes: Ctes, expected?: Value): Value {
    if (++this.#depth > 256) {
      this.#depth--;
      this.diagnostic("TSQ002", "Resolver nesting exceeds limit", expression.range);
      return unknown;
    }
    try {
      return this.resolveExpression(expression, scope, ctes, expected);
    } finally {
      this.#depth--;
    }
  }
  resolveExpression(expression: Expression, scope: Scope, ctes: Ctes, expected?: Value): Value {
    switch (expression.kind) {
      case "parameter":
        return this.parameter(expression, expected);
      case "literal": {
        if (expression.literal === "null")
          return expected ? { ...expected, nullable: true, sqlNull: true } : { ...unknown, sqlNull: true };
        if (expression.literal === "string")
          return type(
            `${expression.unicode ? "nvarchar" : "varchar"}(${Math.max(1, Math.min(String(expression.value).length, expression.unicode ? 4000 : 8000))})`,
            false,
            this.policy,
          );
        if (expression.literal === "binary")
          return type(`varbinary(${Math.max(1, Math.ceil(String(expression.value).length / 2))})`, false, this.policy);
        const text = String(expression.value);
        if (/[eE]/u.test(text)) {
          if (!Number.isFinite(Number(text))) {
            this.diagnostic("TSQ201", "Numeric literal exceeds finite SQL Server floating range", expression.range);
            return unknown;
          }
          return type("float(53)", false, this.policy);
        }
        if (text.includes(".")) {
          const [integral, fraction = ""] = text.split(".");
          const precision = Math.max(1, integral!.replace(/^0+/u, "").length + fraction.length);
          if (precision > 38) {
            this.diagnostic("TSQ201", "Numeric literal exceeds SQL Server decimal precision", expression.range);
            return unknown;
          }
          return decimalType(precision, fraction.length, false, this.policy);
        }
        if (text.replace(/^0+/u, "").length > 38) {
          this.diagnostic("TSQ201", "Integer literal exceeds SQL Server decimal precision", expression.range);
          return unknown;
        }
        const integer = BigInt(text);
        return integer <= 2147483647n
          ? type("int", false, this.policy)
          : decimalType(text.length, 0, false, this.policy);
      }
      case "column":
        return this.column(expression.name, scope);
      case "system":
        return [
          "ROWCOUNT",
          "ERROR",
          "TRANCOUNT",
          "SPID",
          "FETCH_STATUS",
          "NESTLEVEL",
          "OPTIONS",
          "DATEFIRST",
          "LOCK_TIMEOUT",
        ].includes(expression.name)
          ? type("int", false, this.policy)
          : expression.name === "IDENTITY"
            ? type("decimal(38,0)", true, this.policy)
            : unknown;
      case "default":
        return expected ?? unknown;
      case "star":
        this.diagnostic("TSQ201", "Star is valid only as a projection or COUNT argument", expression.range);
        return unknown;
      case "cast": {
        const declaredTarget = parseSqlServerNativeType(expression.databaseType);
        const targetText =
          declaredTarget &&
          ["char", "varchar", "nchar", "nvarchar"].includes(declaredTarget.name) &&
          typeof this.schema.server?.settings.collation === "string"
            ? `${declaredTarget.text} COLLATE ${this.schema.server.settings.collation}`
            : expression.databaseType;
        let target = type(targetText, true, this.policy);
        const argument = this.scalar(this.expression(expression.argument, scope, ctes, target), expression.argument);
        const argumentType = native(argument);
        if (
          argumentType?.collation &&
          declaredTarget &&
          ["char", "varchar", "nchar", "nvarchar"].includes(declaredTarget.name)
        )
          target = type(`${declaredTarget.text} COLLATE ${argumentType.collation}`, true, this.policy);
        if (argument.databaseType && !argumentType)
          this.diagnostic(
            "TSQ201",
            "Opaque native type conversions require explicit qualified codec evidence",
            expression.range,
          );
        const input = argumentType?.name,
          destination = native(target)?.name;
        if (
          destination === "xml" &&
          input &&
          !["xml", "varchar", "nvarchar", "char", "nchar", "text", "ntext", "binary", "varbinary", "image"].includes(
            input,
          )
        )
          this.diagnostic("TSQ201", `Explicit conversion from ${input} to xml is not permitted`, expression.range);
        if (
          input &&
          destination &&
          ((numericNames.has(input) && ["date", "time", "datetime2", "datetimeoffset"].includes(destination)) ||
            (["date", "time", "datetime2", "datetimeoffset"].includes(input) && numericNames.has(destination)))
        )
          this.diagnostic(
            "TSQ201",
            `Explicit conversion from ${input} to ${destination} is not permitted`,
            expression.range,
          );
        if (expression.style) this.expected(expression.style, type("int", false, this.policy), scope, ctes);
        if (native(target)?.name === "json") this.requireVersion(17, expression.range, "Native JSON");
        return {
          ...target,
          nullable: expression.try || argument.nullable,
        };
      }
      case "unary": {
        const value = this.expression(expression.argument, scope, ctes, expected);
        if (expression.operator === "NOT") {
          this.predicate(expression.argument, scope, ctes);
          return { ...condition, nullable: value.nullable };
        }
        const name = native(value)?.name;
        if (name && !numericNames.has(name))
          this.diagnostic("TSQ201", "Unary arithmetic requires a numeric input", expression.range);
        return value;
      }
      case "binary": {
        if (expression.operator === "AND" || expression.operator === "OR") {
          const left = this.predicate(expression.left, scope, ctes);
          const right = this.predicate(expression.right, scope, ctes);
          return { ...condition, nullable: left.nullable || right.nullable };
        }
        let left = this.expression(expression.left, scope, ctes),
          right = this.expression(expression.right, scope, ctes);
        if (expression.left.kind === "parameter" && right.tsType !== "unknown")
          left = this.expected(expression.left, right, scope, ctes);
        if (expression.right.kind === "parameter" && left.tsType !== "unknown")
          right = this.expected(expression.right, left, scope, ctes);
        if (comparison.has(expression.operator)) {
          this.scalar(left, expression.left);
          this.scalar(right, expression.right);
          const names = [native(left)?.name, native(right)?.name];
          if (
            names.some((name) => ["xml", "json", "image"].includes(name ?? "")) ||
            (!["LIKE", "NOT LIKE"].includes(expression.operator) &&
              names.some((name) => ["text", "ntext"].includes(name ?? "")))
          )
            this.diagnostic(
              "TSQ201",
              "This native SQL Server type does not support scalar comparison operators",
              expression.range,
            );
          this.common(left, right, expression.range);
          return { ...condition, nullable: left.nullable || right.nullable };
        }
        const a = native(left),
          b = native(right);
        const nullable = left.nullable || right.nullable;
        if (
          expression.operator === "+" &&
          a?.length !== undefined &&
          b?.length !== undefined &&
          ["char", "varchar", "nchar", "nvarchar"].includes(a.name) &&
          ["char", "varchar", "nchar", "nvarchar"].includes(b.name)
        ) {
          const unicode = a.name.startsWith("n") || b.name.startsWith("n"),
            limit = unicode ? 4000 : 8000;
          const length = a.length === "max" || b.length === "max" ? "max" : Math.min(limit, a.length + b.length);
          if (a.collation && b.collation && a.collation.toLowerCase() !== b.collation.toLowerCase())
            this.diagnostic("TSQ201", "Concatenation has conflicting native collations", expression.range);
          const collation = a.collation ?? b.collation;
          return type(
            `${unicode ? "nvarchar" : "varchar"}(${length})${collation ? ` COLLATE ${collation}` : ""}`,
            nullable,
            this.policy,
          );
        }
        if (a && b && numericNames.has(a.name) && numericNames.has(b.name)) {
          if (["float", "real"].includes(a.name) || ["float", "real"].includes(b.name))
            return this.common(left, right, expression.range);
          if (a.name === "decimal" || b.name === "decimal") {
            const [ap, as] = decimalDimensions(a),
              [bp, bs] = decimalDimensions(b);
            switch (expression.operator) {
              case "+":
              case "-":
                return decimalType(
                  Math.max(ap - as, bp - bs) + Math.max(as, bs) + 1,
                  Math.max(as, bs),
                  nullable,
                  this.policy,
                );
              case "*":
                return decimalType(ap + bp + 1, as + bs, nullable, this.policy, true);
              case "/": {
                const scale = Math.max(6, as + bp + 1);
                return decimalType(ap - as + bs + scale, scale, nullable, this.policy, true);
              }
              case "%":
                return decimalType(
                  Math.min(ap - as, bp - bs) + Math.max(as, bs),
                  Math.max(as, bs),
                  nullable,
                  this.policy,
                );
              default:
                break;
            }
          }
          return this.common(left, right, expression.range);
        }
        if (left.tsType !== "unknown" && right.tsType !== "unknown")
          this.diagnostic("TSQ201", "Unsupported arithmetic operand types", expression.range);
        return unknown;
      }
      case "isnull":
        this.scalar(this.expression(expression.argument, scope, ctes), expression.argument);
        return condition;
      case "in": {
        let argument = this.expression(expression.argument, scope, ctes);
        const values = Array.isArray(expression.values) ? expression.values : undefined;
        const compared = values
          ? values.map((value) => this.expression(value, scope, ctes, argument))
          : this.select(expression.values as Select, ctes, scope, true);
        if (!values && compared.length !== 1)
          this.diagnostic("TSQ203", "IN subquery must return one column", expression.range);
        if (expression.argument.kind === "parameter" && compared[0])
          argument = this.expected(expression.argument, compared[0], scope, ctes);
        for (const value of compared) this.common(argument, value, expression.range);
        return { ...condition, nullable: argument.nullable || compared.some((value) => value.nullable) };
      }
      case "between": {
        let value = this.expression(expression.argument, scope, ctes);
        const lower = this.expression(expression.lower, scope, ctes, value),
          upper = this.expression(expression.upper, scope, ctes, value);
        if (expression.argument.kind === "parameter" && lower.tsType !== "unknown")
          value = this.expected(expression.argument, lower, scope, ctes);
        this.common(value, lower, expression.range);
        this.common(value, upper, expression.range);
        return { ...condition, nullable: value.nullable || lower.nullable || upper.nullable };
      }
      case "exists":
        this.select(expression.query, ctes, scope, true);
        return condition;
      case "subquery": {
        const columns = this.select(expression.query, ctes, scope, true);
        if (columns.length !== 1) {
          this.diagnostic("TSQ203", "Scalar subquery must return exactly one column", expression.range);
          return unknown;
        }
        return { ...columns[0]!, nullable: true };
      }
      case "case": {
        if (expression.operand) this.scalar(this.expression(expression.operand, scope, ctes), expression.operand);
        let result: Value | undefined;
        for (const arm of expression.arms) {
          if (expression.operand)
            this.expression(arm.when, scope, ctes, this.expression(expression.operand, scope, ctes));
          else this.predicate(arm.when, scope, ctes);
          const branch = this.scalar(this.expression(arm.then, scope, ctes, expected), arm.then);
          result = result ? this.common(result, branch, expression.range) : branch;
        }
        if (expression.otherwise) {
          const branch = this.scalar(
            this.expression(expression.otherwise, scope, ctes, expected),
            expression.otherwise,
          );
          result = result ? this.common(result, branch, expression.range) : branch;
        }
        const output = { ...(result ?? unknown), nullable: !expression.otherwise || result?.nullable === true };
        if (native(output)?.name !== "json") delete output.jsonFragment;
        return output;
      }
      case "call":
        return this.call(expression, scope, ctes, expected);
    }
  }
  call(expression: Expression & { kind: "call" }, scope: Scope, ctes: Ctes, expected?: Value): Value {
    this.validateRoutineQualification(expression.name);
    const name = partsLast(expression.name).toUpperCase();
    if (expression.returningJson) this.requireVersion(17, expression.range, "Native JSON RETURNING");
    if (expression.name.parts.length === 1 && name === "NEWSEQUENTIALID")
      this.diagnostic("TSQ203", "NEWSEQUENTIALID is valid only in a DEFAULT constraint", expression.range);
    if (expression.name.parts.length === 1 && name === "ISJSON" && expression.arguments.length > 1)
      this.requireVersion(16, expression.range, "ISJSON type constraint");
    const builtin = expression.name.parts.length === 1 ? SQLSERVER_BUILTINS[name] : undefined;
    if (!builtin) {
      const candidates = Object.values(this.schema.functions ?? {}).filter(
        (fn) =>
          this.same(fn.name, partsLast(expression.name)) &&
          fn.argumentTypes.length === expression.arguments.length &&
          (!expression.name.parts.at(-2) || this.same(fn.schema ?? "dbo", expression.name.parts.at(-2)!)),
      );
      if (candidates.length !== 1) {
        this.diagnostic("TSQ105", `Unknown or ambiguous function ${expression.name.parts.join(".")}`, expression.range);
        for (const argument of expression.arguments) this.expression(argument, scope, ctes);
        return unknown;
      }
      const routine = candidates[0]!;
      if (expression.name.parts.length < 2)
        this.diagnostic(
          "TSQ105",
          "SQL Server scalar user functions require an explicit schema qualifier",
          expression.range,
        );
      expression.arguments.forEach((argument, index) => {
        this.expected(argument, type(routine.argumentTypes[index]!, true, this.policy), scope, ctes);
      });
      return routine.databaseReturnType
        ? type(routine.databaseReturnType, routine.nullable, this.policy)
        : { tsType: routine.returnType, nullable: routine.nullable };
    }
    if (
      expression.arguments.length < builtin.minimumArguments ||
      expression.arguments.length > builtin.maximumArguments
    )
      this.diagnostic(
        "TSQ202",
        `${name} expects ${builtin.minimumArguments}–${builtin.maximumArguments} arguments`,
        expression.range,
      );
    if (builtin.since) this.requireVersion(builtin.since, expression.range, name, builtin.compatibility);
    if (builtin.kind === "window" && !expression.over)
      this.diagnostic("TSQ203", `${name} requires OVER`, expression.range);
    if (builtin.kind === "aggregate" && !expression.over)
      for (const argument of expression.arguments)
        walkExpression(argument, {
          expression: (value) => {
            if (
              value.kind === "subquery" ||
              value.kind === "exists" ||
              (value.kind === "call" &&
                value.name.parts.length === 1 &&
                (SQLSERVER_BUILTINS[partsLast(value.name).toUpperCase()]?.kind === "aggregate" || value.over))
            )
              this.diagnostic(
                "TSQ203",
                "An aggregate argument cannot contain an aggregate, window function or subquery",
                value.range,
              );
          },
        });
    if (builtin.kind === "window")
      for (const argument of expression.arguments)
        walkExpression(argument, {
          expression: (value) => {
            if (value.kind === "call" && value.over)
              this.diagnostic("TSQ203", "Analytic arguments cannot contain an analytic function", value.range);
          },
        });
    if (expression.over) {
      if (
        builtin.kind === "window" &&
        !["PERCENTILE_CONT", "PERCENTILE_DISC"].includes(name) &&
        !expression.over.order.length
      )
        this.diagnostic("TSQ203", `${name} requires ORDER BY within OVER`, expression.over.range);
      if (expression.over.frame) {
        const frame = expression.over.frame;
        if (!expression.over.order.length)
          this.diagnostic("TSQ203", "Window frames require ORDER BY", expression.over.range);
        if (builtin.kind === "window" && !["FIRST_VALUE", "LAST_VALUE"].includes(name))
          this.diagnostic("TSQ203", `${name} does not accept a window frame`, expression.over.range);
        const position = (boundary: typeof frame.start): number | undefined =>
          boundary.kind === "current"
            ? 0
            : boundary.unbounded
              ? boundary.kind === "preceding"
                ? -Infinity
                : Infinity
              : numericConstant(boundary.offset!) === undefined
                ? undefined
                : (boundary.kind === "preceding" ? -1 : 1) * numericConstant(boundary.offset!)!;
        for (const boundary of [frame.start, frame.end])
          if (boundary?.offset) {
            const value = numericConstant(boundary.offset);
            if (frame.kind === "range")
              this.diagnostic("TSQ203", "RANGE does not support numeric PRECEDING/FOLLOWING offsets", boundary.range);
            if (value === undefined || !Number.isSafeInteger(value) || value < 0)
              this.diagnostic("TSQ203", "ROWS frame offsets require nonnegative integer literals", boundary.range);
          }
        const first = position(frame.start),
          last = frame.end ? position(frame.end) : 0;
        if (
          (frame.start.unbounded && frame.start.kind === "following") ||
          (frame.end?.unbounded && frame.end.kind === "preceding") ||
          (first !== undefined && last !== undefined && first > last)
        )
          this.diagnostic(
            "TSQ203",
            "Window frame boundaries are reversed or unbounded in an invalid direction",
            expression.over.range,
          );
      }
      if (expression.distinct) this.diagnostic("TSQ203", "Window aggregates do not support DISTINCT", expression.range);
      if (["STRING_AGG", "JSON_ARRAYAGG", "JSON_OBJECTAGG"].includes(name))
        this.diagnostic("TSQ203", `${name} does not support OVER`, expression.range);
      for (const value of expression.over.partition) this.expression(value, scope, ctes);
      for (const order of expression.over.order) this.expression(order.expression, scope, ctes);
      for (const boundary of [expression.over.frame?.start, expression.over.frame?.end])
        if (boundary?.offset) this.expected(boundary.offset, type("int", false, this.policy), scope, ctes);
      if (builtin.kind === "scalar")
        this.diagnostic("TSQ203", `${name} is not a window or aggregate function`, expression.range);
    }
    if (expression.distinct && builtin.kind !== "aggregate")
      this.diagnostic("TSQ203", `${name} does not accept DISTINCT`, expression.range);
    for (const order of expression.withinGroup ?? []) this.expression(order.expression, scope, ctes);
    const dateRule =
      ["dateadd", "datepart", "datename", "datediff", "datediffBig"].includes(builtin.rule) ||
      ["DATETRUNC", "DATE_BUCKET"].includes(name);
    const args = expression.arguments.map((argument, index) => {
      if (dateRule && index === 0) {
        if (
          argument.kind !== "column" ||
          argument.name.parts.length !== 1 ||
          !SQLSERVER_DATEPARTS.has(argument.name.parts[0]!.toUpperCase())
        )
          this.diagnostic("TSQ203", `${name} requires a supported constant datepart`, argument.range);
        return type("varchar(20)", false, this.policy);
      }
      if (argument.kind === "star" && ["COUNT", "COUNT_BIG", "CHECKSUM", "BINARY_CHECKSUM"].includes(name))
        return type("int", false, this.policy);
      const value = this.expression(argument, scope, ctes);
      return name === "IIF" && index === 0 ? value : this.scalar(value, argument);
    });
    const infer = (index: number, target: Value) => {
      const argument = expression.arguments[index];
      if (argument && argument.kind !== "star") args[index] = this.expected(argument, target, scope, ctes);
    };
    const first = args[0] ?? unknown,
      nullable = builtin.nullable && args.some((value) => value.nullable);
    if (["PERCENTILE_DISC", "PERCENTILE_CONT"].includes(name)) {
      const percentile = expression.arguments[0];
      const value =
        percentile?.kind === "literal" && percentile.literal === "number" ? Number(percentile.value) : undefined;
      if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1)
        this.diagnostic(
          "TSQ203",
          "Percentiles require a numeric literal between zero and one",
          percentile?.range ?? expression.range,
        );
      if (expression.withinGroup?.length !== 1)
        this.diagnostic("TSQ203", "Percentiles require exactly one WITHIN GROUP ordering expression", expression.range);
      if (expression.over?.order.length)
        this.diagnostic("TSQ203", "Percentiles do not accept ORDER BY inside OVER", expression.over.range);
      const ordering = expression.withinGroup?.[0]?.expression;
      const result = ordering ? this.scalar(this.expression(ordering, scope, ctes), ordering) : unknown;
      if (name === "PERCENTILE_CONT" && !numericNames.has(native(result)?.name ?? ""))
        this.diagnostic(
          "TSQ201",
          "PERCENTILE_CONT requires numeric ordering values",
          ordering?.range ?? expression.range,
        );
      return name === "PERCENTILE_DISC" ? { ...result, nullable: true } : type("float(53)", true, this.policy);
    }
    switch (builtin.rule) {
      case "count":
        return type(
          "int",
          !(this.schema.server?.settings.ansiWarnings === true || this.schema.server?.settings.arithAbort === true),
          this.policy,
        );
      case "countBig":
        return type("bigint", false, this.policy);
      case "integer": {
        const argument = native(args[name === "CHARINDEX" ? 1 : 0] ?? unknown);
        const wide = ["LEN", "DATALENGTH", "CHARINDEX", "PATINDEX"].includes(name) && argument?.length === "max";
        return type(wide ? "bigint" : "int", nullable, this.policy);
      }
      case "abs": {
        const argument = native(first);
        if (!argument) return unknown;
        if (argument.name === "decimal") {
          // Pinned native14–17 builds retain ABS precision; both DMF and runtime variant metadata agree.
          const precision = name === "ABS" ? argument.precision : 38;
          const scale = ["DEGREES", "RADIANS"].includes(name) ? 18 : argument.scale;
          return type(`decimal(${precision},${scale})`, nullable, this.policy);
        }
        if (["int", "smallint", "tinyint"].includes(argument.name)) return type("int", nullable, this.policy);
        if (["money", "smallmoney"].includes(argument.name)) return type("money", nullable, this.policy);
        if (
          ["real", "float", "bit"].includes(argument.name) ||
          (name === "POWER" && ["char", "varchar", "nchar", "nvarchar"].includes(argument.name))
        )
          return type("float(53)", nullable, this.policy);
        if (argument.name === "bigint") return type("bigint", nullable, this.policy);
        this.diagnostic("TSQ201", "ABS requires a numeric input", expression.range);
        return unknown;
      }
      case "identity":
        return type("decimal(38,0)", true, this.policy);
      case "variant":
        return type("sql_variant", true, this.policy);
      case "dateTrunc":
      case "dateBucket": {
        const position = builtin.rule === "dateTrunc" ? 1 : 2;
        if (args[position]?.tsType === "unknown") infer(position, type("datetime2(7)", true, this.policy));
        const argument = expression.arguments[position];
        if (argument?.kind === "literal" && argument.literal === "string") {
          if (builtin.rule === "dateBucket")
            this.diagnostic("TSQ201", "DATE_BUCKET requires a typed temporal date argument", argument.range);
          return type("datetime2(7)", nullable, this.policy);
        }
        return { ...(args[position] ?? unknown), nullable };
      }
      case "grouping":
        return type(name === "GROUPING" ? "tinyint" : "int", false, this.policy);
      case "bigint":
        if (name === "NTILE") infer(0, type("bigint", false, this.policy));
        return type("bigint", nullable, this.policy);
      case "float":
        return type("float(53)", builtin.kind === "aggregate" || nullable, this.policy);
      case "real":
        return type("real", nullable, this.policy);
      case "bit":
        return { ...(name === "REGEXP_LIKE" ? condition : bool), nullable };
      case "uuid":
        return type("uniqueidentifier", nullable, this.policy);
      case "bytes":
        return type("varbinary(max)", nullable, this.policy);
      case "string":
        return type(name === "SOUNDEX" ? "varchar(4)" : "nvarchar(4000)", nullable, this.policy);
      case "nvarcharMax":
        if (name === "STRING_AGG") {
          if (first.tsType === "unknown") infer(0, type("nvarchar(max)", true, this.policy));
          const input = native(args[0] ?? unknown),
            separator = native(args[1] ?? unknown);
          if (
            input &&
            ["char", "varchar"].includes(input.name) &&
            separator &&
            ["nchar", "nvarchar"].includes(separator.name)
          )
            this.diagnostic(
              "TSQ201",
              "STRING_AGG VARCHAR input cannot use an NVARCHAR separator",
              expression.arguments[1]!.range,
            );
          const unicode = !input || !["char", "varchar"].includes(input.name),
            length = input?.length === "max" ? "max" : unicode ? 4000 : 8000;
          if (args[1]?.tsType === "unknown")
            infer(1, type(`${unicode ? "nvarchar" : "varchar"}(max)`, true, this.policy));
          return type(
            `${unicode ? "nvarchar" : "varchar"}(${length})${input?.collation ? ` COLLATE ${input.collation}` : ""}`,
            true,
            this.policy,
          );
        }
        for (let i = 0; i < args.length; i++)
          if (args[i]?.tsType === "unknown") infer(i, type("nvarchar(max)", true, this.policy));
        return type("nvarchar(max)", builtin.kind === "aggregate" || nullable, this.policy);
      case "varcharMax":
        return type("varchar(max)", nullable, this.policy);
      case "date":
        return type("date", nullable, this.policy);
      case "datetime":
        return type("datetime", nullable, this.policy);
      case "datetime2":
        return type("datetime2(7)", nullable, this.policy);
      case "datetimeoffset":
        return type("datetimeoffset(7)", nullable, this.policy);
      case "same": {
        const input = native(first);
        if (!input) return unknown;
        if (input.name === "decimal")
          return type(
            `decimal(${input.precision},${["CEILING", "FLOOR"].includes(name) ? 0 : input.scale})`,
            nullable,
            this.policy,
          );
        if (["int", "smallint", "tinyint"].includes(input.name)) return type("int", nullable, this.policy);
        if (["money", "smallmoney"].includes(input.name)) return type("money", nullable, this.policy);
        if (["bit", "real", "float"].includes(input.name)) return type("float(53)", nullable, this.policy);
        if (input.name === "bigint") return { ...first, nullable };
        this.diagnostic("TSQ201", `${name} requires a numeric input`, expression.range);
        return unknown;
      }
      case "nullableSame":
        if (["MIN", "MAX"].includes(name) && native(first)?.name === "bit")
          this.diagnostic("TSQ201", `${name} does not accept BIT`, expression.range);
        if (["LAG", "LEAD"].includes(name)) {
          if (args[1]) {
            infer(1, type("bigint", false, this.policy));
            const offset = numericConstant(expression.arguments[1]!);
            if (offset !== undefined && offset < 0)
              this.diagnostic("TSQ203", `${name} offset must not be negative`, expression.arguments[1]!.range);
          }
          if (args[2] && first.tsType !== "unknown") infer(2, first);
        } else if (args.length > 1 && first.tsType !== "unknown") infer(1, first);
        if (
          ["MIN", "MAX"].includes(name) &&
          ["xml", "json", "text", "ntext", "image"].includes(native(first)?.name ?? "")
        )
          this.diagnostic("TSQ201", `${name} does not accept this native type`, expression.range);
        return { ...first, nullable: true };
      case "sum":
      case "avg": {
        const input = native(first);
        if (!input) {
          if (first.tsType !== "unknown")
            this.diagnostic("TSQ201", `${name} requires a numeric argument`, expression.range);
          return unknown;
        }
        if (!numericNames.has(input.name)) {
          this.diagnostic("TSQ201", `${name} does not accept ${input.name}`, expression.range);
          return unknown;
        }
        if (input.name === "decimal")
          return type(
            `decimal(38,${builtin.rule === "avg" ? Math.max(6, input.scale!) : input.scale})`,
            true,
            this.policy,
          );
        if (["tinyint", "smallint", "int"].includes(input.name)) return type("int", true, this.policy);
        return type(
          input.name === "real" || input.name === "float"
            ? "float(53)"
            : input.name === "smallmoney"
              ? "money"
              : input.text,
          true,
          this.policy,
        );
      }
      case "isnull": {
        let result = first;
        if (first.tsType === "unknown" && args[1]?.tsType !== "unknown") {
          infer(0, args[1]!);
          result = args[0]!;
        }
        if (args[1]) infer(1, result);
        if (result.json || args[1]?.json) {
          const merged = this.common(result, args[1] ?? unknown, expression.range);
          const base = { ...merged };
          delete base.databaseType;
          return {
            ...base,
            ...(result.databaseType === undefined ? {} : { databaseType: result.databaseType }),
            nullable: result.nullable && (args[1]?.nullable ?? true),
          };
        }
        return { ...result, nullable: result.nullable && (args[1]?.nullable ?? true) };
      }
      case "coalesce":
      case "leastGreatest": {
        let result = args.find((value) => value.tsType !== "unknown") ?? expected ?? unknown;
        for (let i = 0; i < args.length; i++) {
          if (args[i]!.tsType === "unknown") infer(i, result);
          result = this.common(result, args[i]!, expression.range);
        }
        return {
          ...result,
          nullable:
            builtin.rule === "coalesce" ? args.every((value) => value.nullable) : args.every((value) => value.nullable),
        };
      }
      case "iif":
        this.predicate(expression.arguments[0]!, scope, ctes);
        return this.common(args[1] ?? unknown, args[2] ?? unknown, expression.range);
      case "choose":
        infer(0, type("int", false, this.policy));
        return {
          ...args.slice(1).reduce((left, right) => this.common(left, right, expression.range), unknown),
          nullable: true,
        };
      case "dateadd": {
        infer(1, type(Number(this.schema.server?.versionKey) >= 17 ? "bigint" : "int", false, this.policy));
        if (args[2]?.tsType === "unknown") infer(2, type("datetime2(7)", true, this.policy));
        return { ...(args[2] ?? unknown), nullable: args[1]?.nullable === true || args[2]?.nullable === true };
      }
      case "datepart":
      case "datename":
        if (args[1]?.tsType === "unknown") infer(1, type("datetime2(7)", true, this.policy));
        return type(builtin.rule === "datepart" ? "int" : "nvarchar(4000)", args[1]?.nullable ?? true, this.policy);
      case "datediff":
      case "datediffBig":
        for (const index of [1, 2])
          if (args[index]?.tsType === "unknown") infer(index, type("datetime2(7)", true, this.policy));
        return type(
          builtin.rule === "datediff" ? "int" : "bigint",
          args.slice(1).some((value) => value.nullable),
          this.policy,
        );
      case "jsonValue":
      case "jsonQuery":
      case "jsonModify": {
        infer(0, type("nvarchar(max)", true, this.policy));
        if (expression.arguments[1]) infer(1, type("nvarchar(4000)", false, this.policy));
        if (builtin.rule === "jsonValue") return type("nvarchar(4000)", true, this.policy);
        const shape: JsonShape =
          builtin.rule === "jsonQuery" &&
          (!expression.arguments[1] ||
            (expression.arguments[1].kind === "literal" && expression.arguments[1].value === "$"))
            ? (first.json?.shape ?? { kind: "unknown" })
            : { kind: "unknown" };
        return {
          tsType: this.policy.json === "parsed" ? this.jsonType(shape) : "string",
          nullable: builtin.rule === "jsonQuery" || first.nullable,
          databaseType: "nvarchar(max)",
          json: { shape, representation: this.policy.json === "parsed" ? "parsed" : "text" },
          ...(builtin.rule === "jsonQuery" ? { jsonFragment: true } : {}),
        };
      }
      case "jsonArray":
      case "jsonObject": {
        for (const [index, value] of args.entries())
          if (
            (builtin.rule === "jsonArray" || index % 2 === 1) &&
            (["xml", "sql_variant"].includes(native(value)?.name ?? "") || (value.databaseType && !native(value)))
          )
            this.diagnostic(
              "TSQ201",
              "This native type requires an explicit supported scalar conversion before JSON serialization",
              expression.arguments[index]!.range,
            );
        let shape: JsonShape;
        if (builtin.rule === "jsonArray") {
          shape = {
            kind: "array",
            element: args.length
              ? { kind: "union", variants: args.map((value) => this.shape(value)) }
              : { kind: "unknown" },
          };
        } else {
          const properties: Record<string, { shape: JsonShape; optional?: boolean }> = {};
          if (expression.arguments.length % 2)
            this.diagnostic("TSQ202", "JSON_OBJECT requires key/value pairs", expression.range);
          for (let i = 0; i < args.length; i += 2) {
            const key = expression.arguments[i];
            if (key?.kind !== "literal" || key.literal !== "string") {
              this.diagnostic(
                "TSQ203",
                "Exact JSON_OBJECT shape requires constant string keys",
                key?.range ?? expression.range,
              );
              continue;
            }
            if (Object.hasOwn(properties, String(key.value))) {
              this.diagnostic("TSQ203", "Duplicate JSON object keys have ambiguous native path semantics", key.range);
              continue;
            }
            Object.defineProperty(properties, String(key.value), {
              value: {
                shape: this.shape(args[i + 1] ?? unknown),
                ...(expression.jsonNullClause === "absent" && args[i + 1]?.nullable ? { optional: true } : {}),
              },
              enumerable: true,
            });
          }
          shape = { kind: "object", properties };
        }
        return {
          tsType: this.policy.json === "parsed" ? this.jsonType(shape) : "string",
          nullable: builtin.kind === "aggregate",
          databaseType: expression.returningJson ? "json" : "nvarchar(max)",
          jsonFragment: true,
          json: { shape, representation: this.policy.json === "parsed" ? "parsed" : "text" },
        };
      }
    }
  }
  cteScope(withClauses: readonly Cte[], inherited: Ctes, outer?: Scope): Ctes {
    const ctes = new Map(inherited);
    for (const cte of withClauses) {
      if (new Set(cte.columns.map((name) => this.key(name))).size !== cte.columns.length)
        this.diagnostic("TSQ203", "CTE column names must be unique", cte.range);
      if ([...ctes.keys()].some((name) => this.same(name, cte.name)))
        this.diagnostic("TSQ102", `Duplicate CTE ${cte.name}`, cte.range);
      let recursive = false;
      walkStatement(cte.query, {
        source: (source) => {
          if (source.kind === "table" && source.name.parts.length === 1 && this.same(partsLast(source.name), cte.name))
            recursive = true;
        },
      });
      if (recursive) {
        if (!cte.query.compounds.length) {
          this.diagnostic("TSQ203", "Recursive CTE requires anchor and UNION ALL member", cte.range);
          continue;
        }
        const references = (query: Select): boolean => {
          let found = false;
          walkStatement(query, {
            source: (source) => {
              if (
                source.kind === "table" &&
                source.name.parts.length === 1 &&
                this.same(source.name.parts[0]!, cte.name)
              )
                found = true;
            },
          });
          return found;
        };
        const firstMember = cte.query.compounds.findIndex((compound) => references(compound.query));
        const anchor = this.select(
          { ...cte.query, compounds: cte.query.compounds.slice(0, Math.max(0, firstMember)) },
          ctes,
          outer,
          cte.columns.length > 0,
        );
        if (cte.columns.length && cte.columns.length !== anchor.length)
          this.diagnostic("TSQ203", "CTE column count disagrees with anchor", cte.range);
        const initial: Relation = {
          key: cte.name,
          qualifiers: [cte.name],
          columns: anchor.map((column, index) => ({
            ...column,
            name: cte.columns[index] ?? column.name,
            nullable: true,
          })),
        };
        ctes.set(cte.name, initial);
        if (firstMember < 0)
          this.diagnostic(
            "TSQ203",
            "Recursive CTE requires a nonrecursive anchor before its recursive member",
            cte.range,
          );
        for (const compound of cte.query.compounds.slice(Math.max(0, firstMember))) {
          if (compound.operator !== "union" || !compound.all || !references(compound.query))
            this.diagnostic("TSQ203", "Recursive members must follow anchors using UNION ALL", compound.query.range);
          const member = this.select(compound.query, ctes, outer, cte.columns.length > 0);
          if (
            member.length !== anchor.length ||
            member.some((column, index) => column.databaseType !== anchor[index]?.databaseType)
          )
            this.diagnostic(
              "TSQ201",
              "Recursive member native types must match the anchor exactly",
              compound.query.range,
            );
          let selfCount = 0;
          walkStatement(compound.query, {
            statement: (query) => {
              if (
                query.kind === "select" &&
                (query.distinct ||
                  query.group.length ||
                  query.having ||
                  query.top ||
                  query.joins.some((join) => ["left", "right", "full", "outer-apply"].includes(join.kind)))
              )
                this.diagnostic(
                  "TSQ203",
                  "Recursive members cannot use DISTINCT, grouping, TOP or outer joins",
                  query.range,
                );
            },
            source: (source) => {
              if (
                source.kind === "table" &&
                source.name.parts.length === 1 &&
                this.same(source.name.parts[0]!, cte.name)
              )
                selfCount++;
            },
            expression: (value) => {
              if (
                value.kind === "subquery" ||
                value.kind === "exists" ||
                (value.kind === "call" &&
                  value.name.parts.length === 1 &&
                  SQLSERVER_BUILTINS[partsLast(value.name).toUpperCase()]?.kind === "aggregate" &&
                  !value.over)
              )
                this.diagnostic(
                  "TSQ203",
                  "Recursive members cannot contain subqueries or scalar aggregation",
                  value.range,
                );
            },
          });
          if (selfCount !== 1)
            this.diagnostic(
              "TSQ203",
              "Recursive members require exactly one recursive table reference",
              compound.query.range,
            );
        }
        ctes.set(cte.name, initial);
      } else {
        const columns = this.select(cte.query, ctes, outer, cte.columns.length > 0);
        if (cte.columns.length && cte.columns.length !== columns.length)
          this.diagnostic("TSQ203", "CTE column count disagrees with its query", cte.range);
        ctes.set(cte.name, {
          key: cte.name,
          qualifiers: [cte.name],
          columns: columns.map((column, index) => ({ ...column, name: cte.columns[index] ?? column.name })),
        });
      }
    }
    return ctes;
  }
  projection(projections: readonly Projection[], scope: Scope, ctes: Ctes, allowUnnamed = false): ResolvedColumn[] {
    const columns: ResolvedColumn[] = [];
    for (const projection of projections) {
      const expression = projection.expression;
      if (expression.kind === "star") {
        const qualifier = expression.qualifier?.parts.join(".");
        const relations = scope.relations.filter(
          (relation) => qualifier === undefined || relation.qualifiers.some((name) => this.same(name, qualifier)),
        );
        if (!relations.length) this.diagnostic("TSQ100", "Projection star has no matching relation", expression.range);
        for (const relation of relations)
          for (const column of relation.columns)
            if (!column.hidden) columns.push({ ...column, range: expression.range });
      } else {
        const value = this.scalar(this.expression(expression, scope, ctes), expression);
        const name =
          projection.alias ??
          (expression.kind === "column"
            ? partsLast(expression.name)
            : allowUnnamed
              ? `column_${columns.length + 1}`
              : undefined);
        if (!name) {
          this.diagnostic(
            "TSQ207",
            "Computed SQL Server result expressions require an explicit alias",
            expression.range,
          );
          continue;
        }
        columns.push({ ...value, name, range: projection.range, runtimeType: runtime(value, this.policy) });
      }
    }
    const seen = new Set<string>();
    for (const column of columns) {
      if (!allowUnnamed && seen.has(column.name))
        this.diagnostic("TSQ207", `Duplicate result column ${column.name}`, column.range);
      seen.add(column.name);
    }
    return columns;
  }
  select(statement: Select, inherited: Ctes = new Map(), outer?: Scope, allowUnnamed = false): ResolvedColumn[] {
    const ctes = this.cteScope(statement.with, inherited, outer);
    const scope = this.buildScope(statement.from, statement.joins, ctes, outer);
    if (statement.where) this.predicate(statement.where, scope, ctes);
    for (const group of statement.group) this.scalar(this.expression(group, scope, ctes), group);
    if (statement.having) this.predicate(statement.having, scope, ctes);
    if (statement.top)
      this.expected(
        statement.top.count,
        type(statement.top.percent ? "float(53)" : "bigint", false, this.policy),
        scope,
        ctes,
      );
    if (statement.top) {
      const value = numericConstant(statement.top.count);
      if (value !== undefined && (value < 0 || (statement.top.percent && value > 100)))
        this.diagnostic(
          "TSQ203",
          "TOP requires a nonnegative count or a percentage from zero to one hundred",
          statement.top.range,
        );
    }
    if (statement.offset) {
      this.expected(statement.offset, type("bigint", false, this.policy), scope, ctes);
      const value = numericConstant(statement.offset);
      if (value !== undefined && value < 0)
        this.diagnostic("TSQ203", "OFFSET must be nonnegative", statement.offset.range);
    }
    if (statement.fetch) {
      this.expected(statement.fetch, type("bigint", false, this.policy), scope, ctes);
      const value = numericConstant(statement.fetch);
      if (value !== undefined && value < 1)
        this.diagnostic("TSQ203", "FETCH must be greater than zero", statement.fetch.range);
    }
    let columns = this.projection(statement.projections, scope, ctes, allowUnnamed);
    for (const compound of statement.compounds) {
      const right = this.select(compound.query, ctes, outer, true);
      if (columns.length !== right.length)
        this.diagnostic("TSQ203", "Set operation projections have different widths", compound.query.range);
      columns = columns.map((column, index) => ({
        ...column,
        ...this.common(column, right[index] ?? unknown, compound.query.range),
      }));
    }
    const outputScope: Scope = { relations: [{ key: "projection", qualifiers: [], columns }] };
    for (const order of statement.order) {
      const orderExpression = order.expression;
      if (
        orderExpression.kind === "column" &&
        orderExpression.name.parts.length === 1 &&
        columns.some((column) => this.same(column.name, partsLast(orderExpression.name)))
      )
        this.scalar(this.expression(order.expression, outputScope, ctes), order.expression);
      else this.scalar(this.expression(order.expression, scope, ctes), order.expression);
    }
    const expressionKinds = new Set([
      "parameter",
      "column",
      "literal",
      "system",
      "default",
      "star",
      "cast",
      "unary",
      "binary",
      "case",
      "call",
      "between",
      "in",
      "exists",
      "isnull",
      "subquery",
    ]);
    const children = (expression: Expression): Expression[] => {
      const result: Expression[] = [];
      const collect = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const child of value) collect(child);
          return;
        }
        if ("kind" in value) {
          if (value.kind === "select") return;
          if (expressionKinds.has(String(value.kind))) {
            result.push(value as Expression);
            return;
          }
        }
        for (const [key, child] of Object.entries(value)) if (key !== "range" && key !== "name") collect(child);
      };
      for (const [key, value] of Object.entries(expression)) if (key !== "range" && key !== "name") collect(value);
      return result;
    };
    const columnIdentity = (expression: Expression & { kind: "column" }): string => {
      const name = partsLast(expression.name),
        qualifier = expression.name.parts.slice(0, -1).join(".");
      const matches = scope.relations.filter(
        (relation) =>
          (!qualifier || relation.qualifiers.some((value) => this.same(value, qualifier))) &&
          relation.columns.some((column) => this.same(column.name, name)),
      );
      return matches.length === 1
        ? `${matches[0]!.key}:${this.key(name)}`
        : expression.name.parts.map((part) => this.key(part)).join(".");
    };
    const keyOf = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(keyOf);
      if ("kind" in value && value.kind === "column")
        return { column: columnIdentity(value as Expression & { kind: "column" }) };
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "range")
          .map(([key, child]) => [key, keyOf(child)]),
      );
    };
    const expressionKey = (value: Expression) => JSON.stringify(keyOf(value));
    const grouped = new Set(statement.group.map(expressionKey));
    const forbiddenAggregate = (expression: Expression, context: string): void => {
      if (expression.kind === "subquery" || expression.kind === "exists") return;
      if (
        expression.kind === "call" &&
        ((expression.name.parts.length === 1
          ? SQLSERVER_BUILTINS[partsLast(expression.name).toUpperCase()]?.kind
          : undefined) === "aggregate" ||
          expression.over)
      )
        this.diagnostic("TSQ203", `Aggregate and window functions are not permitted in ${context}`, expression.range);
      for (const child of children(expression)) forbiddenAggregate(child, context);
    };
    if (statement.where) forbiddenAggregate(statement.where, "WHERE");
    for (const group of statement.group) forbiddenAggregate(group, "GROUP BY");
    for (const join of statement.joins) if (join.on) forbiddenAggregate(join.on, "JOIN ON");
    let hasAggregate = false;
    const nonAggregate: Expression[] = [];
    const gather = (expression: Expression): void => {
      if (expression.kind === "subquery" || expression.kind === "exists") return;
      if (
        expression.kind === "call" &&
        (expression.name.parts.length === 1
          ? SQLSERVER_BUILTINS[partsLast(expression.name).toUpperCase()]?.kind
          : undefined) === "aggregate" &&
        !expression.over
      ) {
        hasAggregate = true;
        return;
      }
      if (grouped.has(expressionKey(expression))) return;
      if (expression.kind === "column") nonAggregate.push(expression);
      for (const child of children(expression)) gather(child);
    };
    if (statement.having) gather(statement.having);
    for (const projection of statement.projections) gather(projection.expression);
    if (hasAggregate || statement.group.length || statement.having)
      for (const expression of nonAggregate)
        this.diagnostic("TSQ203", "Non-aggregate column must be present in GROUP BY", expression.range);
    if (statement.distinct) {
      const projected = new Set(statement.projections.map((projection) => expressionKey(projection.expression)));
      const directColumns = new Set(
        statement.projections
          .filter((projection) => projection.expression.kind === "column")
          .map((projection) => expressionKey(projection.expression)),
      );
      if (statement.projections.some((projection) => projection.expression.kind === "star"))
        for (const relation of scope.relations)
          for (const column of relation.columns)
            directColumns.add(JSON.stringify({ column: `${relation.key}:${this.key(column.name)}` }));
      const checkOrder = (expression: Expression): void => {
        if (projected.has(expressionKey(expression))) return;
        if (expression.kind === "column") {
          if (
            expression.name.parts.length === 1 &&
            columns.some((column) => this.same(column.name, partsLast(expression.name)))
          )
            return;
          if (!directColumns.has(expressionKey(expression)))
            this.diagnostic(
              "TSQ203",
              "SELECT DISTINCT ORDER BY columns must appear in the projection",
              expression.range,
            );
        }
        for (const child of children(expression)) checkOrder(child);
      };
      for (const order of statement.order) checkOrder(order.expression);
    }
    if (statement.forJson) {
      // The server may stream one document across multiple NVARCHAR rows. Each row is a text chunk.
      columns = [
        {
          name: "JSON_F52E2B61-18A1-11d1-B105-00805F49916B",
          tsType: "string",
          nullable: false,
          databaseType: "nvarchar(max)",
          range: statement.range,
        },
      ];
    }
    return columns;
  }
  output(
    output: Output | undefined,
    target: Relation,
    scope: Scope,
    ctes: Ctes,
    operation: "insert" | "update" | "delete",
  ): ResolvedColumn[] {
    if (!output) return [];
    const aliases: Relation[] = [];
    if (operation !== "delete") aliases.push({ ...target, key: "inserted", qualifiers: ["inserted"] });
    if (operation !== "insert") aliases.push({ ...target, key: "deleted", qualifiers: ["deleted"] });
    const columns = this.projection(
      output.projections,
      { relations: [...aliases, ...scope.relations] },
      ctes,
      output.into !== undefined,
    );
    if (output.into) {
      const destination = this.relation(output.into, ctes);
      const targets = output.columns.length
        ? output.columns.map((name) => destination.columns.find((column) => this.same(column.name, name)))
        : destination.columns.filter(
            (column) =>
              !column.hidden &&
              destination.catalog?.columns[column.name]?.identity !== "always" &&
              (!destination.catalog || destination.catalog.columns[column.name]?.generated === "none"),
          );
      if (targets.length !== columns.length)
        this.diagnostic("TSQ203", "OUTPUT INTO width disagrees with its target columns", output.range);
      if (new Set(output.columns.map((name) => this.key(name))).size !== output.columns.length)
        this.diagnostic("TSQ203", "OUTPUT INTO target column list contains duplicates", output.range);
      for (const [index, target] of targets.entries()) {
        if (!target) this.diagnostic("TSQ101", "OUTPUT INTO contains an unknown target column", output.range);
        else {
          if (destination.catalog?.columns[target.name]?.insertable === false)
            this.diagnostic("TSQ203", `OUTPUT INTO target ${target.name} is not insertable`, output.range);
          if (columns[index]) this.common(columns[index]!, target, output.range);
        }
      }
      return [];
    }
    return columns;
  }
  statement(statement: Statement): ResolvedColumn[] {
    if (statement.kind === "select") return this.select(statement);
    const ctes = this.cteScope(statement.with, new Map());
    let scope: Scope;
    let target: Relation;
    if (statement.kind !== "insert" && statement.from) {
      scope = this.buildScope(statement.from, statement.joins, ctes);
      const alias =
        statement.target.parts.length === 1
          ? scope.relations.find((relation) =>
              relation.qualifiers.some((name) => this.same(name, partsLast(statement.target))),
            )
          : undefined;
      target = alias ?? this.relation(statement.target, ctes);
    } else {
      target = this.relation(statement.target, ctes);
      scope = { relations: [target] };
    }
    if (statement.output && !statement.output.into && target.catalog?.capabilities?.outputWithoutInto === false)
      this.diagnostic(
        "TSQ203",
        "OUTPUT without INTO is unavailable for a target with enabled triggers",
        statement.output.range,
      );
    if (statement.kind === "insert") {
      if (statement.values.length > 1000)
        this.diagnostic("TSQ203", "SQL Server INSERT VALUES supports at most one thousand rows", statement.range);
      const columns = statement.columns.length
        ? statement.columns.map((name) => target.columns.find((column) => this.same(column.name, name)))
        : target.columns.filter(
            (column) =>
              !column.hidden &&
              target.catalog?.columns[column.name]?.identity !== "always" &&
              (!target.catalog || target.catalog.columns[column.name]?.generated === "none"),
          );
      if (statement.columns.some((_name, index) => !columns[index]))
        this.diagnostic("TSQ101", "INSERT contains an unknown target column", statement.target.range);
      if (new Set(statement.columns.map((name) => this.key(name))).size !== statement.columns.length)
        this.diagnostic("TSQ203", "INSERT column list contains duplicates", statement.range);
      for (const column of columns)
        if (column && target.catalog?.columns[column.name]?.insertable === false)
          this.diagnostic("TSQ203", `Column ${column.name} is not insertable`, statement.target.range);
      for (const row of statement.values) {
        if (row.length !== columns.length)
          this.diagnostic("TSQ203", "INSERT value count disagrees with target columns", statement.range);
        row.forEach((expression, index) => {
          this.scalar(this.expression(expression, { relations: [] }, ctes, columns[index]), expression);
        });
      }
      if (statement.query) {
        const source = this.select(statement.query, ctes, undefined, true);
        if (source.length !== columns.length)
          this.diagnostic("TSQ203", "INSERT SELECT width disagrees with target columns", statement.query.range);
        source.forEach((value, index) => {
          if (columns[index]) this.common(value, columns[index]!, statement.query!.range);
        });
      }
    } else {
      if (statement.top) this.expected(statement.top.count, type("bigint", false, this.policy), scope, ctes);
      if (statement.where) this.predicate(statement.where, scope, ctes);
      if (statement.kind === "update")
        for (const assignment of statement.assignments) {
          const column = target.columns.find((value) => this.same(value.name, partsLast(assignment.column)));
          if (!column)
            this.diagnostic("TSQ101", `Unknown UPDATE target ${assignment.column.parts.join(".")}`, assignment.range);
          if (column && target.catalog?.columns[column.name]?.updatable === false)
            this.diagnostic("TSQ203", `Column ${column.name} is not updatable`, assignment.column.range);
          this.scalar(this.expression(assignment.value, scope, ctes, column), assignment.value);
        }
    }
    return this.output(statement.output, target, scope, ctes, statement.kind);
  }
}
export function resolveSqlServerStatement(
  statement: Statement,
  schema: SchemaSnapshot,
  options: ResolveSqlServerOptions = {},
): Omit<DialectAnalysis, "semantics"> {
  const resolver = new Resolver(schema, options);
  const columns = resolver.statement(statement);
  return {
    columns,
    parameters: [...resolver.parameters.values()].sort((a, b) => a.index - b.index),
    diagnostics: resolver.diagnostics,
    resultKind: statement.kind === "select" || (statement.output && !statement.output.into) ? "rows" : "command",
  };
}
