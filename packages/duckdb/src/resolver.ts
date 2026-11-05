import {
  type DialectAnalysis,
  defineQuerySemantics,
  type QueryDependency,
  type ResolvedColumn,
  type ResolvedParameter,
  type RuntimeValueType,
  type SourceRange,
  type SqlDiagnostic,
} from "@typed-sql/core";
import { duckDBBuiltinSignatures } from "./catalog/index.js";
import { matchDuckDBBuiltin } from "./catalog/resolution.js";
import {
  type DuckDBType,
  duckDBAsciiFold,
  duckDBTypeChildren,
  formatDuckDBType,
  parseDuckDBType,
} from "./native-types.js";
import { tokenize } from "./parser/tokenizer.js";
import {
  duckDBExpressionChildren,
  type Expression,
  type Projection,
  type Relation,
  type Statement,
} from "./parser/types.js";
import type { DuckDBSchemaSnapshot } from "./snapshot.js";
import { type DuckDBTypePolicy, duckDBRuntimeType, duckDBTypeScript } from "./type-policy.js";

interface Value {
  readonly type: DuckDBType;
  readonly nullable: boolean;
  readonly tsType?: string;
  readonly runtimeType?: RuntimeValueType;
}
interface Field extends Value {
  readonly range?: SourceRange;
  readonly name: string;
  readonly relation?: string;
  readonly schema?: string;
  readonly catalog?: string;
  readonly usingHidden?: boolean;
}
interface Scope {
  readonly fields: readonly Field[];
  readonly aliases: Map<string, Value>;
  readonly ctes: Map<string, readonly Field[]>;
  readonly windowNames?: ReadonlySet<string>;
  readonly aggregateScope?: Scope;
}
const scalar = (name: string): DuckDBType => ({ kind: "scalar", name }),
  unknown: Value = { type: scalar("ANY"), nullable: true },
  nil: Value = { type: scalar("NULL"), nullable: true };
const bool = (nullable: boolean): Value => ({ type: scalar("BOOLEAN"), nullable });
const same = (a: DuckDBType, b: DuckDBType) => formatDuckDBType(a) === formatDuckDBType(b);
const small = new Set(["TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER"]),
  wide = new Set(["BIGINT", "UBIGINT", "HUGEINT", "UHUGEINT", "BIGNUM"]);
function decimalProperties(type: Extract<DuckDBType, { kind: "scalar" }>): { precision: number; scale: number } {
  const widths: Readonly<Record<string, number>> = {
    BOOLEAN: 1,
    TINYINT: 3,
    UTINYINT: 3,
    SMALLINT: 5,
    USMALLINT: 5,
    INTEGER: 10,
    UINTEGER: 10,
    BIGINT: 19,
    UBIGINT: 20,
    HUGEINT: 38,
    UHUGEINT: 38,
  };
  return type.name === "DECIMAL"
    ? { precision: type.precision!, scale: type.scale! }
    : { precision: widths[type.name] ?? 38, scale: 0 };
}
function isNumeric(type: DuckDBType): boolean {
  return (
    type.kind === "scalar" &&
    (small.has(type.name) || wide.has(type.name) || ["DECIMAL", "FLOAT", "DOUBLE"].includes(type.name))
  );
}
export function commonDuckDBType(a: DuckDBType, b: DuckDBType): DuckDBType {
  if (same(a, b)) return a;
  if (a.kind === "scalar" && a.name === "NULL") return b;
  if (b.kind === "scalar" && b.name === "NULL") return a;
  if (a.kind === "scalar" && a.name === "ANY") return b;
  if (b.kind === "scalar" && b.name === "ANY") return a;
  if (isNumeric(a) && isNumeric(b) && a.kind === "scalar" && b.kind === "scalar") {
    if ([a.name, b.name].includes("DOUBLE")) return scalar("DOUBLE");
    if ([a.name, b.name].includes("FLOAT")) return scalar("FLOAT");
    if (a.name === "DECIMAL" || b.name === "DECIMAL") {
      const shape = (x: typeof a) => {
        const value = decimalProperties(x);
        return [value.precision, value.scale];
      };
      const [ap, as] = shape(a),
        [bp, bs] = shape(b),
        scale = Math.max(as!, bs!);
      return {
        kind: "scalar",
        name: "DECIMAL",
        precision: Math.min(38, Math.max(ap! - as!, bp! - bs!) + scale),
        scale,
      };
    }
    if (a.name === "BIGNUM" || b.name === "BIGNUM") return scalar("BIGNUM");
    if ([a.name, b.name].includes("UHUGEINT"))
      return a.name.startsWith("U") && b.name.startsWith("U") ? scalar("UHUGEINT") : scalar("BIGNUM");
    if ([a.name, b.name].includes("HUGEINT")) return scalar("HUGEINT");
    if ([a.name, b.name].includes("UBIGINT"))
      return a.name.startsWith("U") && b.name.startsWith("U") ? scalar("UBIGINT") : scalar("HUGEINT");
    if ([a.name, b.name].includes("BIGINT")) return scalar("BIGINT");
    if ([a.name, b.name].includes("UINTEGER"))
      return a.name.startsWith("U") && b.name.startsWith("U") ? scalar("UINTEGER") : scalar("BIGINT");
    return scalar("INTEGER");
  }
  if ((a.kind === "list" || a.kind === "array") && (b.kind === "list" || b.kind === "array"))
    return { kind: "list", element: commonDuckDBType(a.element, b.element) };
  if (a.kind === "struct" && b.kind === "struct") {
    const names = [
      ...a.fields.map((x) => x.name),
      ...b.fields
        .map((x) => x.name)
        .filter((x) => !a.fields.some((y) => duckDBAsciiFold(y.name) === duckDBAsciiFold(x))),
    ];
    return {
      kind: "struct",
      fields: names.map((name) => ({
        name,
        type: commonDuckDBType(
          a.fields.find((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(name))?.type ?? nil.type,
          b.fields.find((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(name))?.type ?? nil.type,
        ),
      })),
    };
  }
  return scalar("ANY");
}
function nullableUnion(values: readonly Value[]): Value {
  return {
    type: values.reduce((type, value) => commonDuckDBType(type, value.type), nil.type),
    nullable: values.some((value) => value.nullable),
  };
}
const emptyScope = (): Scope => ({ fields: [], aliases: new Map(), ctes: new Map() });
export class DuckDBResolver {
  readonly diagnostics: SqlDiagnostic[] = [];
  readonly parameters = new Map<number, { value: Value; range: SourceRange }>();
  readonly dependencies: QueryDependency[] = [];
  private calls = 0;
  private effect: "read" | "write" | "ddl" | "unknown" = "read";
  private volatile = false;
  private unknownVolatility = false;
  private sessionAffinity = false;
  constructor(
    readonly snapshot: DuckDBSchemaSnapshot,
    readonly policy: DuckDBTypePolicy,
  ) {}
  error(message: string, range: SourceRange, code = "TSQ101"): void {
    this.diagnostics.push({ code, message, range, severity: "error" });
  }
  recordParameter(expr: Expression, value: Value): void {
    const index = Number(expr.value),
      old = this.parameters.get(index);
    const unconstrained = (type: DuckDBType) => type.kind === "scalar" && ["ANY", "NULL"].includes(type.name);
    if (old && unconstrained(value.type) && !unconstrained(old.value.type)) return;
    if (old && !unconstrained(old.value.type) && !unconstrained(value.type) && !same(old.value.type, value.type)) {
      this.error("Repeated parameter has incompatible native types", expr.range, "TSQ202");
      return;
    }
    if (value.type.kind === "scalar" && value.type.name === "NULL") value = old?.value ?? unknown;
    this.parameters.set(index, { value, range: expr.range });
  }
  infer(expr: Expression, scope: Scope, expected?: Value): Value {
    if (++this.calls > 100000) {
      this.error("DuckDB analysis work limit", expr.range, "TSQ002");
      return unknown;
    }
    const arg = (expression: Expression | undefined, hint?: Value): Value =>
      expression ? this.infer(expression, scope, hint) : nil;
    switch (expr.kind) {
      case "parameter": {
        const value = expected ?? this.parameters.get(Number(expr.value))?.value ?? unknown;
        this.recordParameter(expr, value);
        return value;
      }
      case "literal": {
        if (expr.value === "NULL") return nil;
        if (expr.value === "TRUE" || expr.value === "FALSE") return bool(false);
        if (expr.value?.startsWith('"')) return { type: scalar("VARCHAR"), nullable: false };
        if (expr.value?.match(/[.eE]/u)) {
          const [whole, fraction = ""] = (expr.value.split(/[eE]/u)[0] ?? "").split(".");
          if (/[eE]/u.test(expr.value)) return { type: scalar("DOUBLE"), nullable: false };
          return {
            type: {
              kind: "scalar",
              name: "DECIMAL",
              precision: Math.min(38, (whole?.replace(/^0+/u, "").length ?? 0) + fraction.length || 1),
              scale: fraction.length,
            },
            nullable: false,
          };
        }
        try {
          const value = BigInt(expr.value ?? 0);
          return {
            type: scalar(value <= 2147483647n ? "INTEGER" : value <= 9223372036854775807n ? "BIGINT" : "HUGEINT"),
            nullable: false,
          };
        } catch {
          return unknown;
        }
      }
      case "name": {
        if (expr.left) {
          const base = arg(expr.left),
            field = expr.names?.[0];
          if ((base.type.kind === "struct" || base.type.kind === "union") && field) {
            const found = base.type.fields.find((item) => duckDBAsciiFold(item.name) === duckDBAsciiFold(field));
            if (found) return { type: found.type, nullable: true };
          }
          this.error("Unknown native field", expr.range);
          return unknown;
        }
        const names = expr.names ?? [],
          name = names[names.length - 1] ?? "";
        const candidates = scope.fields.filter(
          (field) =>
            duckDBAsciiFold(field.name) === duckDBAsciiFold(name) &&
            (names.length !== 1 || !field.usingHidden) &&
            (names.length < 3 || duckDBAsciiFold(field.schema ?? "") === duckDBAsciiFold(names[names.length - 3]!)) &&
            (names.length < 4 || duckDBAsciiFold(field.catalog ?? "") === duckDBAsciiFold(names[names.length - 4]!)) &&
            (names.length === 1 ||
              duckDBAsciiFold(field.relation ?? "") === duckDBAsciiFold(names[names.length - 2] ?? "")),
        );
        if (candidates.length === 1) {
          const found = candidates[0]!;
          this.dependencies.push({
            kind: "column",
            access: "read",
            name: found.name,
            ...(found.schema ? { schema: found.schema } : {}),
            ...(found.relation ? { parent: found.relation } : {}),
            certainty: "resolved",
            range: expr.range,
          });
          return found;
        }
        if (!candidates.length && names.length === 1 && scope.aliases.has(duckDBAsciiFold(name)))
          return scope.aliases.get(duckDBAsciiFold(name))!;
        if (
          names.length === 1 &&
          ["CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "LOCALTIME", "LOCALTIMESTAMP"].includes(
            name.toUpperCase(),
          )
        )
          return {
            type: scalar(
              name.toUpperCase().includes("DATE")
                ? "DATE"
                : name.toUpperCase().includes("TIMESTAMP")
                  ? name.toUpperCase() === "LOCALTIMESTAMP"
                    ? "TIMESTAMP"
                    : "TIMESTAMPTZ"
                  : "TIME",
            ),
            nullable: false,
          };
        this.error(
          candidates.length ? `Ambiguous column ${name}` : `Unknown column ${name}`,
          expr.range,
          candidates.length ? "TSQ102" : "TSQ101",
        );
        return unknown;
      }
      case "cast": {
        const type = parseDuckDBType(expr.nativeType!);
        const newSyntax = (value: DuckDBType): boolean =>
          value.kind === "tuple" ||
          (value.kind === "scalar" && ["TIME_NS", "TIMESTAMPTZ_NS"].includes(value.name)) ||
          duckDBTypeChildren(value).some(newSyntax);
        if (this.snapshot.server?.versionKey !== "2.0.0" && newSyntax(type))
          this.error("TUPLE/TIME_NS/TIMESTAMPTZ_NS SQL type syntax requires DuckDB2.0", expr.range, "TSQ401");
        arg(expr.left, { type, nullable: true });
        return { type, nullable: expr.value === "TRY_CAST" || arg(expr.left).nullable };
      }
      case "unary": {
        const value = arg(expr.left, expected);
        return expr.value === "NOT" || expr.value === "EXISTS"
          ? bool(expr.value === "EXISTS" ? false : value.nullable)
          : value;
      }
      case "binary": {
        const left = arg(expr.left),
          right = arg(expr.right, left.type.kind === "scalar" && left.type.name === "ANY" ? undefined : left);
        if (expr.left?.kind === "parameter") this.recordParameter(expr.left, right);
        if (expr.value?.startsWith("IS")) return bool(false);
        if (
          ["=", "!=", "<>", "<", ">", "<=", ">=", "LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "AND", "OR"].includes(
            expr.value ?? "",
          )
        )
          return bool(left.nullable || right.nullable);
        if (["->", "->>"].includes(expr.value ?? "")) {
          if (left.type.kind !== "scalar" || !["JSON", "VARCHAR"].includes(left.type.name)) {
            this.error("JSON extraction needs JSON or VARCHAR input", expr.range, "TSQ201");
            return unknown;
          }
          const element = scalar(expr.value === "->" ? "JSON" : "VARCHAR");
          return {
            type: right.type.kind === "list" || right.type.kind === "array" ? { kind: "list", element } : element,
            nullable: true,
          };
        }
        if (expr.value === "||") {
          if (
            (left.type.kind === "list" || left.type.kind === "array") &&
            (right.type.kind === "list" || right.type.kind === "array")
          )
            return {
              type: { kind: "list", element: commonDuckDBType(left.type.element, right.type.element) },
              nullable: left.nullable || right.nullable,
            };
          if (
            left.type.kind === "scalar" &&
            right.type.kind === "scalar" &&
            left.type.name === "BLOB" &&
            right.type.name === "BLOB"
          )
            return { type: scalar("BLOB"), nullable: left.nullable || right.nullable };
          if (left.type.kind === "scalar" && right.type.kind === "scalar")
            return { type: scalar("VARCHAR"), nullable: left.nullable || right.nullable };
          this.error("Incompatible concatenation operands", expr.range, "TSQ201");
          return unknown;
        }
        const operators = matchDuckDBBuiltin(this.snapshot.server?.versionKey ?? "", expr.value ?? "", [
          left.type,
          right.type,
        ]);
        if (!operators.length) {
          this.error("No qualified DuckDB operator overload matches the operands", expr.range, "TSQ201");
          return unknown;
        }
        const type = commonDuckDBType(left.type, right.type);
        if (
          type.kind === "scalar" &&
          type.name === "DECIMAL" &&
          ["+", "-", "*", "%"].includes(expr.value ?? "") &&
          left.type.kind === "scalar" &&
          right.type.kind === "scalar"
        ) {
          const l = decimalProperties(left.type),
            r = decimalProperties(right.type);
          const scale = expr.value === "*" ? l.scale + r.scale : Math.max(l.scale, r.scale);
          if (scale > 38) {
            this.error("DECIMAL multiplication scale exceeds DuckDB's exact maximum", expr.range, "TSQ201");
            return unknown;
          }
          let precision =
            expr.value === "*"
              ? l.precision + r.precision
              : Math.max(l.precision - l.scale, r.precision - r.scale) + scale + (expr.value === "%" ? 0 : 1);
          if (expr.value === "*" && precision > 18 && Math.max(l.precision, r.precision) <= 18 && scale < 18)
            precision = 18;
          return {
            type: { kind: "scalar", name: "DECIMAL", precision: Math.min(38, precision), scale: Math.min(38, scale) },
            nullable: left.nullable || right.nullable,
          };
        }
        const best = operators.filter((operator) => operator.score === operators[0]!.score),
          result = best[0]?.result;
        if (result && best.every((operator) => operator.result && same(result, operator.result)))
          return { type: result, nullable: left.nullable || right.nullable };
        if (expr.value === "/") return { type: scalar("DOUBLE"), nullable: left.nullable || right.nullable };
        return { type: scalar("ANY"), nullable: true };
      }
      case "case": {
        const args = expr.args ?? [],
          values: Value[] = [];
        for (let i = 0; i < args.length; i++) {
          if (i % 2 === 1 || (i === args.length - 1 && args.length % 2 === 1)) values.push(arg(args[i], expected));
          else arg(args[i], bool(true));
        }
        if (args.length % 2 === 0) values.push(nil);
        return nullableUnion(values);
      }
      case "list": {
        const args = (expr.args ?? []).map((x) => arg(x));
        return { type: { kind: "list", element: nullableUnion(args).type }, nullable: false };
      }
      case "tuple":
        return { type: { kind: "tuple", elements: (expr.args ?? []).map((x) => arg(x).type) }, nullable: false };
      case "struct": {
        const names = expr.names ?? [];
        if (new Set(names.map(duckDBAsciiFold)).size !== names.length) this.error("Duplicate struct field", expr.range);
        return {
          type: {
            kind: "struct",
            fields: (expr.args ?? []).map((item, i) => ({ name: names[i]!, type: arg(item).type })),
          },
          nullable: false,
        };
      }
      case "index": {
        const base = arg(expr.left);
        for (const item of expr.args ?? []) arg(item);
        if (base.type.kind === "list" || base.type.kind === "array")
          return (expr.args?.length ?? 0) > 1
            ? { type: { kind: "list", element: base.type.element }, nullable: base.nullable }
            : { type: base.type.element, nullable: true };
        if (base.type.kind === "map") {
          arg(expr.args?.[0], { type: base.type.key, nullable: false });
          return { type: base.type.value, nullable: true };
        }
        if (base.type.kind === "tuple") {
          const index = Number(expr.args?.[0]?.value) - 1;
          if (Number.isInteger(index) && base.type.elements[index])
            return { type: base.type.elements[index]!, nullable: true };
        }
        this.error("Indexing needs a known native list/array/map/tuple", expr.range, "TSQ201");
        return unknown;
      }
      case "subquery": {
        const fields = this.query(expr.query!, scope);
        if (fields.length !== 1) {
          this.error("Scalar subquery requires one column", expr.range, "TSQ201");
          return unknown;
        }
        return { ...fields[0]!, nullable: true };
      }
      case "call":
        return this.call(expr, scope, expected);
      case "star":
        return unknown;
      case "lambda": {
        this.error("Lambda requires a typed collection context", expr.range, "TSQ201");
        return unknown;
      }
    }
  }
  aggregate(expression: Expression): boolean {
    if (expression.kind !== "call" || expression.window) return false;
    const name = expression.names?.at(-1)?.toLowerCase() ?? "";
    return (
      ["json_group_array", "json_group_object"].includes(name) ||
      (this.snapshot.formatVersion === 2 &&
        Object.values(this.snapshot.routines)
          .flat()
          .some(
            (routine) => routine.kind === "aggregate" && duckDBAsciiFold(routine.name) === duckDBAsciiFold(name),
          )) ||
      duckDBBuiltinSignatures(this.snapshot.server?.versionKey ?? "", name).some(
        (signature) => signature[1] === "aggregate",
      )
    );
  }
  groupingExpressions(expression: Expression): readonly Expression[] {
    if (
      expression.kind === "call" &&
      ["cube", "rollup", "grouping_sets"].includes(expression.names?.at(-1)?.toLowerCase() ?? "")
    )
      return (expression.args ?? []).flatMap((item) =>
        item.kind === "tuple" ? (item.args ?? []) : this.groupingExpressions(item),
      );
    return [expression];
  }
  validateGrouping(statement: Statement, scope: Scope): void {
    if (statement.kind !== "select") return;
    const aliases = new Map(
      statement.projections.filter((item) => item.alias).map((item) => [duckDBAsciiFold(item.alias!), item.expression]),
    );
    const expand = (expression: Expression, seen = new Set<string>()): Expression => {
      if (expression.kind !== "name" || expression.left || expression.names?.length !== 1) return expression;
      const name = duckDBAsciiFold(expression.names[0]!);
      if (scope.fields.some((field) => !field.usingHidden && duckDBAsciiFold(field.name) === name)) return expression;
      const alias = aliases.get(name);
      if (!alias || seen.has(name)) return expression;
      seen.add(name);
      return expand(alias, seen);
    };
    let work = 0;
    const budget = (expression: Expression, depth: number): boolean => {
      if (++work > 100000 || depth > 128) {
        if (work <= 100001) this.error("DuckDB grouping/alias expansion limit", expression.range, "TSQ002");
        return false;
      }
      return true;
    };
    const key = (input: Expression, depth = 0): string => {
      if (!budget(input, depth)) return "expansion-limit";
      const expression = expand(input);
      if (expression.kind === "name" && !expression.left) {
        const names = expression.names ?? [],
          name = names.at(-1) ?? "",
          candidates = scope.fields.filter(
            (field) =>
              duckDBAsciiFold(field.name) === duckDBAsciiFold(name) &&
              (names.length !== 1 || !field.usingHidden) &&
              (names.length === 1 || duckDBAsciiFold(field.relation ?? "") === duckDBAsciiFold(names.at(-2) ?? "")),
          );
        if (candidates.length === 1)
          return `column:${duckDBAsciiFold(candidates[0]!.relation ?? "")}:${duckDBAsciiFold(name)}`;
      }
      return JSON.stringify([
        expression.kind,
        expression.value,
        expression.names?.map(duckDBAsciiFold),
        expression.nativeType,
        duckDBExpressionChildren(expression).map((child) => key(child, depth + 1)),
      ]);
    };
    const has = (input: Expression, predicate: (expression: Expression) => boolean, depth = 0): boolean => {
      if (!budget(input, depth)) return false;
      const expression = expand(input);
      return (
        predicate(expression) || duckDBExpressionChildren(expression).some((child) => has(child, predicate, depth + 1))
      );
    };
    const projections = statement.projections.map((item) => item.expression),
      groups = (statement.group ?? [])
        .flatMap((expression) => this.groupingExpressions(expression))
        .map((expression) => {
          if (expression.kind === "literal" && /^[1-9]\d*$/u.test(expression.value ?? "")) {
            const projection = projections[Number(expression.value) - 1];
            if (!projection) {
              this.error("GROUP BY ordinal exceeds projection count", expression.range, "TSQ201");
              return expression;
            }
            return projection;
          }
          return expand(expression);
        });
    const aggregating = Boolean(
      statement.groupAll ||
        (statement.group?.length ?? 0) ||
        statement.having ||
        [...projections, ...(statement.order ?? [])].some((expression) =>
          has(expression, (item) => this.aggregate(item)),
        ),
    );
    const grouped = new Set(groups.map((expression) => key(expression)));
    if (
      !statement.group?.length &&
      projections.some((expression) =>
        has(
          expression,
          (item) =>
            item.kind === "call" && ["grouping", "grouping_id"].includes(item.names?.at(-1)?.toLowerCase() ?? ""),
        ),
      )
    )
      this.error("GROUPING requires GROUP BY expressions", statement.range, "TSQ201");
    if (statement.groupAll)
      for (const expression of projections)
        if (!has(expression, (item) => this.aggregate(item) || Boolean(item.window))) grouped.add(key(expression));
    const check = (
      input: Expression,
      allowAggregate: boolean,
      allowWindow: boolean,
      insideAggregate = false,
      depth = 0,
    ): void => {
      if (!budget(input, depth)) return;
      const expression = expand(input),
        aggregate = this.aggregate(expression);
      if (aggregate) {
        if (!allowAggregate || insideAggregate)
          this.error("Aggregate is not valid in this expression context", expression.range, "TSQ201");
        for (const child of duckDBExpressionChildren(expression)) check(child, true, false, true, depth + 1);
        return;
      }
      if (expression.window && !allowWindow)
        this.error("Window expression is not valid in this context", expression.range, "TSQ201");
      for (const child of duckDBExpressionChildren(expression))
        check(child, allowAggregate, allowWindow && !expression.window, insideAggregate, depth + 1);
    };
    for (const expression of [statement.where, ...groups].filter((value): value is Expression => value !== undefined))
      check(expression, false, false);
    for (const relation of statement.relations) if (relation.condition) check(relation.condition, false, false);
    if (statement.having) check(statement.having, true, false);
    for (const expression of [
      ...projections,
      ...(statement.order ?? []),
      ...(statement.qualify ? [statement.qualify] : []),
    ])
      check(expression, true, true);
    if (
      statement.qualify &&
      ![...projections, statement.qualify].some((expression) => has(expression, (item) => Boolean(item.window)))
    )
      this.error("QUALIFY requires a window expression", statement.qualify.range, "TSQ201");
    if (!aggregating) return;
    const groupedValue = (input: Expression, depth = 0, locals: ReadonlySet<string> = new Set()): void => {
      if (!budget(input, depth)) return;
      if (input.kind === "name" && input.names?.length === 1 && locals.has(duckDBAsciiFold(input.names[0]!))) return;
      const expression = expand(input);
      if (
        expression.kind === "lambda" ||
        (expression.kind === "binary" && expression.value === "->" && expression.left?.kind === "name")
      ) {
        const names = expression.names ?? expression.left?.names ?? [];
        if (expression.right)
          groupedValue(expression.right, depth + 1, new Set([...locals, ...names.map(duckDBAsciiFold)]));
        return;
      }
      if (grouped.has(key(expression)) || this.aggregate(expression) || expression.kind === "subquery") return;
      if (expression.kind === "name" && !expression.left) {
        if (
          scope.fields.some(
            (field) =>
              !field.usingHidden && duckDBAsciiFold(field.name) === duckDBAsciiFold(expression.names?.at(-1) ?? ""),
          )
        )
          this.error("Column must be grouped or aggregated", expression.range, "TSQ201");
        return;
      }
      if (expression.kind === "star") {
        for (const field of scope.fields.filter((field) => !field.usingHidden))
          if (!grouped.has(`column:${duckDBAsciiFold(field.relation ?? "")}:${duckDBAsciiFold(field.name)}`))
            this.error("Star includes an ungrouped column", expression.range, "TSQ201");
        return;
      }
      for (const child of duckDBExpressionChildren(expression)) groupedValue(child, depth + 1, locals);
    };
    for (const expression of [
      ...projections,
      ...(statement.order ?? []),
      ...(statement.having ? [statement.having] : []),
      ...(statement.qualify ? [statement.qualify] : []),
    ])
      groupedValue(expression);
  }
  collectionLambda(expr: Expression, scope: Scope): Value {
    const name = expr.names?.at(-1)?.toLowerCase() ?? "",
      args = expr.args ?? [];
    const reduce = ["list_reduce", "array_reduce", "reduce"].includes(name),
      filter = ["list_filter", "array_filter", "filter"].includes(name);
    if (
      args.length < 2 ||
      args.length > (reduce ? 3 : 2) ||
      !(args[1]?.kind === "lambda" || (args[1]?.kind === "binary" && args[1].value === "->"))
    ) {
      this.error(`${name} requires a typed collection and lambda`, expr.range, "TSQ201");
      return unknown;
    }
    const collection = this.infer(args[0]!, scope),
      lambda = args[1];
    if (collection.type.kind !== "list" && collection.type.kind !== "array") {
      this.error(`${name} needs a LIST or ARRAY`, expr.range, "TSQ201");
      return unknown;
    }
    if (lambda.value === "->" && this.snapshot.server?.versionKey === "2.0.0") {
      this.error("DuckDB2.0 requires lambda x: expression syntax", lambda.range, "TSQ401");
      return unknown;
    }
    if (lambda.value === "->" && this.snapshot.server?.settings.lambda_syntax === "DISABLE_SINGLE_ARROW") {
      this.error("Single-arrow lambda syntax is disabled by recorded settings", lambda.range, "TSQ401");
      return unknown;
    }
    const names =
      lambda.names ??
      (lambda.left?.kind === "name"
        ? [lambda.left.names?.[0] ?? ""]
        : lambda.left?.kind === "tuple"
          ? (lambda.left.args ?? []).map((arg) => (arg.kind === "name" && arg.names?.length === 1 ? arg.names[0]! : ""))
          : []);
    if (
      names.length < (reduce ? 2 : 1) ||
      names.length > (reduce ? 3 : 2) ||
      names.some((name) => !name) ||
      new Set(names.map(duckDBAsciiFold)).size !== names.length
    ) {
      this.error("Invalid lambda binding names or arity", lambda.range, "TSQ201");
      return unknown;
    }
    const element: Value = { type: collection.type.element, nullable: true };
    const initial = args[2] ? this.infer(args[2], scope) : undefined;
    const accumulator = initial ? nullableUnion([element, initial]) : element;
    const bindings = names.map(
      (name, i): Field => ({
        name,
        ...(reduce
          ? i === 0
            ? accumulator
            : i === 1
              ? element
              : { type: scalar("BIGINT"), nullable: false }
          : i === 0
            ? element
            : { type: scalar("BIGINT"), nullable: false }),
      }),
    );
    const aliases = new Map(scope.aliases);
    for (const binding of bindings) aliases.delete(duckDBAsciiFold(binding.name));
    const local: Scope = {
      ...scope,
      aggregateScope: scope.aggregateScope ?? scope,
      aliases,
      fields: [
        ...scope.fields.filter((field) => !names.some((name) => duckDBAsciiFold(name) === duckDBAsciiFold(field.name))),
        ...bindings,
      ],
    };
    const body = this.infer(lambda.right!, local, filter ? bool(true) : reduce ? accumulator : undefined);
    if (filter && !(body.type.kind === "scalar" && (body.type.name === "BOOLEAN" || isNumeric(body.type)))) {
      this.error("LIST filter lambda must return BOOLEAN-compatible values", lambda.range, "TSQ201");
      return unknown;
    }
    if (reduce) {
      const combined = commonDuckDBType(accumulator.type, body.type);
      if (combined.kind === "scalar" && combined.name === "ANY") {
        this.error("LIST reduce lambda has incompatible accumulator type", lambda.range, "TSQ201");
        return unknown;
      }
      return { type: accumulator.type, nullable: true };
    }
    return {
      type: { kind: "list", element: filter ? collection.type.element : body.type },
      nullable: collection.nullable,
    };
  }
  call(expr: Expression, scope: Scope, expected?: Value): Value {
    if (scope.aggregateScope && (this.aggregate(expr) || expr.window))
      return this.call(expr, scope.aggregateScope, expected);
    const name = expr.names?.at(-1)?.toLowerCase() ?? "",
      args = expr.args ?? [];
    if (expr.filter) this.infer(expr.filter, scope, bool(true));
    for (const expression of expr.context ?? []) this.infer(expression, scope);
    if (expr.windowName && !scope.windowNames?.has(duckDBAsciiFold(expr.windowName)))
      this.error(`Unknown named window ${expr.windowName}`, expr.range, "TSQ101");
    if (
      [
        "row_number",
        "rank",
        "dense_rank",
        "percent_rank",
        "cume_dist",
        "ntile",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
      ].includes(name) &&
      !expr.window
    ) {
      this.error(`${name} requires an OVER window clause`, expr.range, "TSQ201");
      return unknown;
    }
    const arity: Readonly<Record<string, number>> = {
      if: 3,
      ifnull: 2,
      nullif: 2,
      json: 1,
      json_group_array: 1,
      json_group_object: 2,
    };
    if (
      (arity[name] !== undefined && args.length !== arity[name]) ||
      (["coalesce", "array_value", "struct_pack"].includes(name) && !args.length)
    ) {
      this.error(`Invalid ${name} argument count`, expr.range, "TSQ201");
      return unknown;
    }
    if (name === "struct_pack" && args.some((_, i) => !expr.argumentNames?.[i])) {
      this.error("struct_pack requires named fields", expr.range, "TSQ201");
      return unknown;
    }

    if (
      [
        "list_transform",
        "array_transform",
        "list_apply",
        "array_apply",
        "apply",
        "list_filter",
        "array_filter",
        "filter",
        "list_reduce",
        "array_reduce",
        "reduce",
      ].includes(name)
    ) {
      return this.collectionLambda(expr, scope);
    }
    const values = args.filter((arg) => arg.kind !== "star").map((arg) => this.infer(arg, scope));
    const version = this.snapshot.server?.versionKey ?? "";
    const builtinName = name === "count" && args[0]?.kind === "star" ? "count_star" : name;
    const signatures = duckDBBuiltinSignatures(version, builtinName);
    const aggregate =
      signatures.some((signature) => signature[1] === "aggregate") ||
      ["json_group_array", "json_group_object"].includes(name);
    const window =
      signatures.some((signature) => signature[1] === "window") ||
      [
        "row_number",
        "rank",
        "dense_rank",
        "percent_rank",
        "cume_dist",
        "ntile",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
      ].includes(name);
    if (
      (expr.window && !aggregate && !window) ||
      (expr.filter && !aggregate) ||
      ((expr.context?.length ?? 0) > 0 && !expr.window && !aggregate)
    ) {
      this.error("Function does not support these aggregate/window modifiers", expr.range, "TSQ201");
      return unknown;
    }

    const matches = matchDuckDBBuiltin(
      version,
      builtinName,
      values.map((value) => value.type),
    );
    this.dependencies.push({
      kind: "function",
      access: "execute",
      name,
      certainty: signatures.length ? "resolved" : "syntactic",
      range: expr.range,
    });
    if (name === "nextval") {
      this.effect = "write";
      this.sessionAffinity = true;
      this.volatile = true;
    } else if (name === "currval") this.sessionAffinity = true;
    else if (matches.some((match) => match.signature[6] === true)) {
      this.volatile = true;
      if (this.effect === "read") this.effect = "unknown";
    }
    if (signatures.length && !matches.length) {
      this.error(
        `No qualified DuckDB overload matches ${name}(${values.map((value) => formatDuckDBType(value.type)).join(", ")})`,
        expr.range,
        "TSQ201",
      );
      return unknown;
    }

    if (
      [
        "between",
        "not between",
        "in",
        "not in",
        "contains",
        "list_contains",
        "map_contains",
        "isnan",
        "isfinite",
        "isinf",
      ].includes(name)
    )
      return bool(values.some((x) => x.nullable));
    if (["coalesce", "ifnull"].includes(name)) {
      const type = nullableUnion(values).type;
      for (const arg of args) if (arg.kind === "parameter") this.recordParameter(arg, { type, nullable: true });
      return { type, nullable: values.every((x) => x.nullable) };
    }
    if (name === "nullif") return { ...(values[0] ?? unknown), nullable: true };
    if (name === "if") {
      if (args[0]) this.infer(args[0], scope, bool(true));
      return nullableUnion(values.slice(1));
    }
    if (["percent_rank", "cume_dist"].includes(name)) return { type: scalar("DOUBLE"), nullable: false };
    if (["grouping", "grouping_id"].includes(name)) {
      if (!values.length || values.length > 63)
        this.error("GROUPING needs one to63 grouped expressions", expr.range, "TSQ201");
      return { type: scalar("BIGINT"), nullable: false };
    }
    if (name === "count_if") return { type: scalar("HUGEINT"), nullable: true };
    if (["count", "count_star", "row_number", "rank", "dense_rank", "ntile"].includes(name))
      return { type: scalar("BIGINT"), nullable: false };
    if (["sum", "sum_no_overflow"].includes(name)) {
      const type = values[0]?.type;
      if (type?.kind === "scalar" && type.name === "DECIMAL")
        return { type: { ...type, precision: 38 }, nullable: true };
      return {
        type:
          type?.kind === "scalar" && type.name === "BIGNUM"
            ? scalar("BIGNUM")
            : type?.kind === "scalar" && type.name === "BOOLEAN"
              ? scalar("HUGEINT")
              : type &&
                  isNumeric(type) &&
                  type.kind === "scalar" &&
                  !["FLOAT", "DOUBLE", "UHUGEINT"].includes(type.name)
                ? scalar("HUGEINT")
                : scalar("DOUBLE"),
        nullable: true,
      };
    }
    if (["median", "quantile_cont", "quantile_disc"].includes(name)) {
      const input = values[0]?.type ?? unknown.type;
      const type =
        name === "quantile_disc"
          ? input
          : input.kind === "scalar" && input.name === "DATE"
            ? scalar("TIMESTAMP")
            : isNumeric(input) && !(input.kind === "scalar" && input.name === "DECIMAL")
              ? scalar("DOUBLE")
              : input;
      const multiple = values[1]?.type.kind === "list" || values[1]?.type.kind === "array";
      return { type: multiple ? { kind: "list", element: type } : type, nullable: true };
    }
    if (["avg", "mean"].includes(name) && values[0]?.type.kind === "scalar" && values[0].type.name === "INTERVAL")
      return { type: scalar("INTERVAL"), nullable: true };
    if (
      [
        "avg",
        "mean",
        "stddev",
        "stddev_samp",
        "stddev_pop",
        "variance",
        "var_samp",
        "var_pop",
        "median",
        "quantile_cont",
        "corr",
        "covar_pop",
        "covar_samp",
        "favg",
        "fsum",
      ].includes(name)
    )
      return { type: scalar("DOUBLE"), nullable: true };
    if (["min", "max"].includes(name) && values.length === 2)
      return { type: { kind: "list", element: values[0]!.type }, nullable: true };
    if (
      [
        "min",
        "max",
        "first",
        "last",
        "arbitrary",
        "any_value",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
      ].includes(name)
    )
      return { ...(values[0] ?? unknown), nullable: true };
    if (
      ["list_sort", "array_sort", "list_reverse_sort", "array_reverse_sort", "list_concat", "array_concat"].includes(
        name,
      )
    ) {
      const collections = values.filter((value) => value.type.kind === "list" || value.type.kind === "array");
      if (
        collections.length &&
        collections.every((value) => value.type.kind === "list" || value.type.kind === "array")
      ) {
        const type = collections.map((value) => value.type).reduce(commonDuckDBType);
        if (type.kind === "list" || type.kind === "array")
          return { type: { kind: "list", element: type.element }, nullable: values.some((value) => value.nullable) };
      }
    }
    if (name === "map_concat" && values.length && values.every((value) => value.type.kind === "map")) {
      const maps = values.map((value) => value.type).filter((type) => type.kind === "map");
      return {
        type: {
          kind: "map",
          key: maps.map((type) => type.key).reduce(commonDuckDBType),
          value: maps.map((type) => type.value).reduce(commonDuckDBType),
        },
        nullable: values.every((value) => value.nullable),
      };
    }
    if (name === "list" || name === "array_agg")
      return { type: { kind: "list", element: values[0]?.type ?? scalar("ANY") }, nullable: true };
    if (name === "list_value" || name === "array_value")
      return {
        type:
          name === "array_value"
            ? { kind: "array", element: nullableUnion(values).type, length: values.length }
            : { kind: "list", element: nullableUnion(values).type },
        nullable: false,
      };
    if (name === "row") return { type: { kind: "tuple", elements: values.map((x) => x.type) }, nullable: false };
    if (name === "struct_pack")
      return {
        type: {
          kind: "struct",
          fields: values.map((value, i) => ({ name: expr.argumentNames?.[i] ?? `_${i}`, type: value.type })),
        },
        nullable: false,
      };
    if (name === "union_value") {
      const tag = expr.argumentNames?.[0];
      if (!tag || args.length !== 1) {
        this.error("union_value needs one named member", expr.range, "TSQ201");
        return unknown;
      }
      return { type: { kind: "union", fields: [{ name: tag, type: values[0]!.type }] }, nullable: false };
    }
    if (name === "union_tag") {
      const type = values[0]?.type;
      if (type?.kind === "union")
        return { type: { kind: "enum", values: type.fields.map((x) => x.name) }, nullable: values[0]!.nullable };
    }
    if (name === "union_extract" || name === "struct_extract") {
      const type = values[0]?.type,
        key =
          args[1]?.kind === "literal" && args[1].value?.startsWith('"')
            ? (JSON.parse(args[1].value) as string)
            : undefined;
      if ((type?.kind === "union" || type?.kind === "struct") && key) {
        const field = type.fields.find((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(key));
        if (field) return { type: field.type, nullable: true };
      }
      this.error("Field extraction needs a static member name and native shape", expr.range, "TSQ201");
      return unknown;
    }
    if (name === "map") {
      const key = values[0]?.type,
        value = values[1]?.type;
      if ((key?.kind === "list" || key?.kind === "array") && (value?.kind === "list" || value?.kind === "array"))
        return {
          type: { kind: "map", key: key.element, value: value.element },
          nullable: values.some((x) => x.nullable),
        };
      if (!values.length && expected?.type.kind === "map") return { ...expected, nullable: false };
      this.error("MAP needs typed key and value lists", expr.range, "TSQ201");
      return unknown;
    }
    if (["map_keys", "map_values", "map_entries", "map_extract", "element_at", "map_extract_value"].includes(name)) {
      const type = values[0]?.type;
      if (type?.kind === "map") {
        if (name === "map_keys") return { type: { kind: "list", element: type.key }, nullable: values[0]!.nullable };
        if (name === "map_values" || name === "map_extract" || name === "element_at")
          return { type: { kind: "list", element: type.value }, nullable: values[0]!.nullable };
        if (name === "map_entries")
          return {
            type: {
              kind: "list",
              element: {
                kind: "struct",
                fields: [
                  { name: "key", type: type.key },
                  { name: "value", type: type.value },
                ],
              },
            },
            nullable: values[0]!.nullable,
          };
        return { type: type.value, nullable: true };
      }
    }
    if (name === "unnest") {
      const type = values[0]?.type;
      if (type?.kind === "list" || type?.kind === "array") return { type: type.element, nullable: true };
      this.error("UNNEST needs a known list/array or projection struct", expr.range, "TSQ201");
      return unknown;
    }
    if (name === "cardinality") return { type: scalar("UBIGINT"), nullable: values.some((value) => value.nullable) };
    if (
      [
        "length",
        "len",
        "array_length",
        "list_count",
        "cardinality",
        "octet_length",
        "bit_length",
        "strpos",
        "position",
      ].includes(name)
    )
      return { type: scalar("BIGINT"), nullable: values.some((x) => x.nullable) };
    if (
      [
        "lower",
        "upper",
        "trim",
        "ltrim",
        "rtrim",
        "concat",
        "concat_ws",
        "substr",
        "substring",
        "replace",
        "printf",
        "format",
        "string_agg",
        "group_concat",
        "listagg",
        "typeof",
      ].includes(name)
    )
      return {
        type: scalar("VARCHAR"),
        nullable: ["concat", "concat_ws", "typeof"].includes(name)
          ? false
          : values.some((x) => x.nullable) || ["string_agg", "group_concat", "listagg"].includes(name),
      };
    if (["ceil", "ceiling", "floor", "round", "trunc"].includes(name)) {
      const type = values[0]?.type;
      if (type?.kind === "scalar" && type.name === "DECIMAL") {
        const precision = args[1]?.kind === "literal" ? Number(args[1].value) : args[1] ? type.scale! : 0;
        const scale = ["ceil", "ceiling", "floor"].includes(name) ? 0 : Math.max(0, Math.min(type.scale!, precision));
        return { type: { ...type, scale }, nullable: values.some((value) => value.nullable) };
      }
      if (matches[0]?.result) return { type: matches[0].result, nullable: values.some((value) => value.nullable) };
    }
    if (name === "abs") return { ...(values[0] ?? unknown) };
    if (["greatest", "least"].includes(name))
      return { ...nullableUnion(values), nullable: values.every((value) => value.nullable) };
    if (
      [
        "json",
        "json_object",
        "json_array",
        "to_json",
        "row_to_json",
        "array_to_json",
        "json_merge_patch",
        "json_extract",
        "json_query",
        "json_group_object",
        "json_group_array",
      ].includes(name)
    )
      return {
        type:
          (name === "json_extract" || name === "json_query") &&
          (values[1]?.type.kind === "list" || values[1]?.type.kind === "array")
            ? { kind: "list", element: scalar("JSON") }
            : scalar("JSON"),
        nullable: !["json_object", "json_array"].includes(name) && values.some((x) => x.nullable),
      };
    if (["json_extract_string", "json_value"].includes(name))
      return {
        type:
          values[1]?.type.kind === "list" || values[1]?.type.kind === "array"
            ? { kind: "list", element: scalar("VARCHAR") }
            : scalar("VARCHAR"),
        nullable: true,
      };
    if (name === "json_valid") return bool(values.some((x) => x.nullable));
    if (["random", "pi", "sin", "cos", "tan", "sqrt", "exp", "ln", "log", "pow", "power"].includes(name))
      return { type: scalar("DOUBLE"), nullable: values.some((x) => x.nullable) };
    if (name === "nextval" || name === "currval") return { type: scalar("BIGINT"), nullable: false };
    if (name === "generate_subscripts") return { type: scalar("BIGINT"), nullable: values.some((x) => x.nullable) };
    if (matches.length) {
      const best = matches.filter((match) => match.score === matches[0]!.score);
      const result = best[0]?.result;
      if (result && best.every((match) => match.result && same(match.result, result))) {
        return { type: result, nullable: true };
      }
    }
    const candidates = Object.values(this.snapshot.formatVersion === 2 ? this.snapshot.routines : {})
      .flat()
      .filter(
        (routine) =>
          duckDBAsciiFold(routine.name) === duckDBAsciiFold(name) &&
          routine.kind !== "procedure" &&
          routine.arguments.length === values.length,
      );
    const exact = candidates.filter((routine) =>
      routine.arguments.every(
        (item, i) =>
          item.databaseType === "ANY" ||
          item.databaseType === "ANY[]" ||
          same(parseDuckDBType(item.databaseType), values[i]!.type),
      ),
    );
    if (exact.length === 1) {
      const routine = exact[0]!;
      if (routine.dataAccess === "unknown" && this.effect === "read") this.effect = "unknown";
      if (routine.volatility === "volatile") this.volatile = true;
      if (routine.volatility === "unknown") this.unknownVolatility = true;

      if (routine.result.kind === "scalar" || routine.result.kind === "set") {
        for (let i = 0; i < args.length; i++)
          if (args[i]?.kind === "parameter")
            this.recordParameter(args[i]!, {
              type: parseDuckDBType(routine.arguments[i]!.databaseType),
              nullable: true,
            });
        return { type: parseDuckDBType(routine.result.databaseType), nullable: true };
      }
    }
    this.error(`Unknown or ambiguous DuckDB function ${name}`, expr.range, "TSQ201");
    return unknown;
  }
  table(names: readonly string[], range: SourceRange): readonly Field[] {
    const currentCatalog = String(this.snapshot.server?.settings.currentCatalog ?? ""),
      currentSchema = String(this.snapshot.server?.settings.currentSchema ?? "main");
    const entries = Object.entries(this.snapshot.tables).map(([key, table]) => {
      const parts = tokenize(key)
        .filter((token) => token.kind === "word" || token.kind === "quoted")
        .map((token) => token.value);
      return {
        key,
        table,
        catalog: parts.length >= 3 ? parts[parts.length - 3]! : currentCatalog,
        schema: parts.length >= 2 ? parts[parts.length - 2]! : (table.schema ?? "main"),
        name: table.name,
      };
    });
    const equal = (a: string, b: string) => duckDBAsciiFold(a) === duckDBAsciiFold(b);
    let matches = entries.filter((entry) => equal(entry.name, names.at(-1) ?? ""));
    if (names.length >= 3)
      matches = matches.filter(
        (entry) => names.length === 3 && equal(entry.catalog, names[0]!) && equal(entry.schema, names[1]!),
      );
    else if (names.length === 2)
      matches = matches.filter(
        (entry) =>
          (equal(entry.catalog, currentCatalog) && equal(entry.schema, names[0]!)) ||
          (equal(entry.catalog, names[0]!) && equal(entry.schema, "main")),
      );
    else {
      const paths: readonly string[][] = (() => {
        const tokens = tokenize(String(this.snapshot.server?.settings.search_path ?? "")),
          result: string[][] = [];
        let path: string[] = [];
        for (const token of tokens) {
          if (token.text === ",") {
            if (path.length) result.push(path);
            path = [];
          } else if (token.kind === "word" || token.kind === "quoted") path.push(token.value);
        }
        if (path.length) result.push(path);
        return [
          ["temp", "main"],
          ...result.map((parts) => (parts.length === 1 ? [currentCatalog, parts[0]!] : parts)),
          [currentCatalog, currentSchema],
          [currentCatalog, "main"],
          ["system", "main"],
        ];
      })();
      for (const [catalog, schema] of paths) {
        const selected = matches.filter((entry) => equal(entry.catalog, catalog!) && equal(entry.schema, schema!));
        if (selected.length) {
          matches = selected;
          break;
        }
      }
      if (
        !matches.some((entry) =>
          paths.some(([catalog, schema]) => equal(entry.catalog, catalog!) && equal(entry.schema, schema!)),
        )
      )
        matches = [];
    }
    const candidates = matches.map((entry) => [entry.key, entry.table] as const);
    if (candidates.length !== 1) {
      this.error(
        candidates.length ? `Ambiguous relation ${names.join(".")}` : `Unknown relation ${names.join(".")}`,
        range,
        "TSQ100",
      );
      return [];
    }
    const [key, table] = candidates[0]!;
    this.dependencies.push({
      kind: "relation",
      access: "read",
      name: table.name,
      ...(table.schema ? { schema: table.schema } : {}),
      certainty: "resolved",
      range,
    });
    return Object.values(table.columns).map((column) => ({
      name: column.name,
      type: parseDuckDBType(column.databaseType),
      nullable: column.nullable,
      tsType: column.tsType,
      relation: names.at(-1) ?? key,
      catalog:
        tokenize(key).filter((token) => token.kind === "word" || token.kind === "quoted").length >= 3
          ? tokenize(key).filter((token) => token.kind === "word" || token.kind === "quoted")[0]!.value
          : String(this.snapshot.server?.settings.currentCatalog ?? ""),
      ...(table.schema ? { schema: table.schema } : {}),
    }));
  }
  relation(relation: Relation, scope: Scope): readonly Field[] {
    let fields: readonly Field[] = [];
    if (relation.query) {
      const names = new Set<string>();
      fields = this.query(relation.query, scope).map((field) => {
        let name = field.name,
          n = 1;
        while (names.has(duckDBAsciiFold(name))) name = `${field.name}_${n++}`;
        names.add(duckDBAsciiFold(name));
        return { ...field, name };
      });
    } else if (relation.name) {
      const cte = relation.name.length === 1 ? scope.ctes.get(duckDBAsciiFold(relation.name[0]!)) : undefined;
      fields = cte ?? this.table(relation.name, relation.range);
    } else if (relation.expression?.kind === "call") {
      const name = relation.expression.names?.at(-1)?.toLowerCase();
      if (name === "range" || name === "generate_series") {
        for (const arg of relation.expression.args ?? [])
          this.infer(arg, scope, { type: scalar("BIGINT"), nullable: false });
        fields = [{ name: name, type: scalar("BIGINT"), nullable: false }];
      } else if (name === "unnest") {
        if (relation.expression.args?.length !== 1)
          this.error("UNNEST table function accepts exactly one LIST/ARRAY argument", relation.range, "TSQ201");
        const value = this.infer(
          relation.expression.args?.[0] ?? { kind: "literal", value: "NULL", range: relation.range },
          scope,
        );
        if (value.type.kind === "list" || value.type.kind === "array")
          fields = [{ name: "unnest", type: value.type.element, nullable: true }];
        else this.error("UNNEST table function needs a known list or array", relation.range, "TSQ201");
      } else this.error(`Unknown table function ${name}`, relation.range, "TSQ201");
    } else this.error("Dynamic relation schema is not supported", relation.range, "TSQ401");
    if (relation.ordinality) fields = [...fields, { name: "ordinality", type: scalar("BIGINT"), nullable: false }];
    if (relation.columns && (relation.columns.length > fields.length || !relation.columns.length))
      this.error("Relation alias column count differs", relation.range, "TSQ201");
    return fields.map((field, i) => ({
      ...field,
      name: relation.columns?.[i] ?? field.name,
      ...(relation.alias ? { relation: relation.alias } : {}),
      nullable: field.nullable || ["left", "asof-left", "full", "positional"].includes(relation.join ?? ""),
    }));
  }
  unnestProjection(expression: Expression, scope: Scope, alias?: string): Field[] {
    const args = expression.args ?? [];
    if (args.length < 1 || args.length > 2) {
      this.error("UNNEST supports one value and at most one static option", expression.range, "TSQ201");
      return [];
    }
    let depth = 1;
    if (args[1]) {
      const option = expression.argumentNames?.[1]?.toLowerCase(),
        value = args[1];
      if (option === "recursive" && value.kind === "literal" && ["TRUE", "FALSE"].includes(value.value ?? ""))
        depth = value.value === "TRUE" ? 64 : 1;
      else if (
        option === "max_depth" &&
        value.kind === "literal" &&
        /^[1-9]\d*$/u.test(value.value ?? "") &&
        Number(value.value) <= 64
      )
        depth = Number(value.value);
      else {
        this.error("UNNEST requires a static recursive BOOLEAN or bounded positive max_depth", value.range, "TSQ401");
        return [];
      }
    }
    let type = this.infer(args[0]!, scope).type;
    if (type.kind !== "list" && type.kind !== "array" && type.kind !== "struct") {
      this.error("UNNEST needs a known LIST, ARRAY or STRUCT", expression.range, "TSQ201");
      return [];
    }
    while (depth > 0 && (type.kind === "list" || type.kind === "array")) {
      type = type.element;
      depth--;
    }
    const expand = (value: DuckDBType, remaining: number, name: string): Field[] => {
      if (remaining > 0 && value.kind === "struct")
        return value.fields.flatMap((field) => expand(field.type, remaining - 1, field.name));
      return [{ name, type: value, nullable: true, range: expression.range }];
    };
    return expand(type, depth, alias ?? "unnest");
  }
  project(projections: readonly Projection[], scope: Scope): Field[] {
    const output: Field[] = [];
    for (const projection of projections) {
      const expression = projection.expression;
      if (expression.kind === "star") {
        const qualifier = expression.left?.kind === "name" ? expression.left.names?.at(-1) : undefined;
        const fields = scope.fields.filter(
          (field) =>
            (qualifier ? duckDBAsciiFold(field.relation ?? "") === duckDBAsciiFold(qualifier) : !field.usingHidden) &&
            !projection.exclude?.some((name) => duckDBAsciiFold(name) === duckDBAsciiFold(field.name)),
        );
        for (const name of projection.exclude ?? [])
          if (!scope.fields.some((field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(name)))
            this.error(`Unknown EXCLUDE column ${name}`, expression.range);
        for (const field of fields) {
          const replacement = projection.replace?.find(
            (item) => duckDBAsciiFold(item.alias ?? "") === duckDBAsciiFold(field.name),
          );
          output.push(
            replacement
              ? { ...this.infer(replacement.expression, scope), name: field.name, range: replacement.expression.range }
              : { ...field, range: expression.range },
          );
        }
        continue;
      }
      if (expression.kind === "call" && expression.names?.at(-1)?.toLowerCase() === "unnest") {
        const fields = this.unnestProjection(expression, scope, projection.alias);
        output.push(...fields);
        for (const field of fields) scope.aliases.set(duckDBAsciiFold(field.name), field);
        continue;
      }
      const value = this.infer(expression, scope),
        name =
          projection.alias ??
          (expression.kind === "name" ? expression.names?.at(-1) : undefined) ??
          (expression.kind === "call" ? expression.names?.at(-1) : undefined) ??
          this.expressionName(expression);
      output.push({ ...value, name, range: expression.range });
      scope.aliases.set(duckDBAsciiFold(name), value);
    }
    return output;
  }
  expressionName(expr: Expression): string {
    if (expr.kind === "literal")
      return expr.value?.startsWith('"') ? (JSON.parse(expr.value) as string) : (expr.value ?? "expression");
    return "expression";
  }
  query(statement: Statement, parent: Scope = emptyScope()): Field[] {
    if (["insert", "update", "delete", "merge", "create"].includes(statement.kind)) {
      this.effect = statement.kind === "create" ? "ddl" : "write";
      if (statement.target)
        this.dependencies.push({
          kind: "relation",
          access: "write",
          name: statement.target.at(-1)!,
          ...(statement.target.length > 1 ? { schema: statement.target.at(-2)! } : {}),
          certainty: "resolved",
          range: statement.range,
        });
    }

    const ctes = new Map(parent.ctes);
    let scope: Scope = { fields: [...parent.fields], aliases: new Map(), ctes };
    const localCTEs = new Set<string>();
    for (const cte of statement.ctes) {
      if (localCTEs.has(duckDBAsciiFold(cte.name))) this.error("Duplicate CTE name", cte.query.range, "TSQ201");
      localCTEs.add(duckDBAsciiFold(cte.name));
      let anchorFields: readonly Field[] | undefined;
      if (
        ["insert", "update", "delete", "merge"].includes(cte.query.kind) &&
        this.snapshot.server?.versionKey !== "2.0.0"
      )
        this.error("Modifying CTEs require DuckDB2.0", cte.query.range, "TSQ401");

      if (cte.recursive) {
        const anchor = cte.query.set ? { ...cte.query, set: undefined } : cte.query;
        const initial = this.query(anchor as Statement, { ...scope, ctes });
        anchorFields = initial;
        ctes.set(
          duckDBAsciiFold(cte.name),
          initial.map((field, i) => ({ ...field, name: cte.columns?.[i] ?? field.name, nullable: true })),
        );
      }
      const fields = this.query(cte.query, scope);
      ctes.set(
        duckDBAsciiFold(cte.name),
        fields.map((field, i) => ({
          ...field,
          ...(anchorFields?.[i]
            ? {
                type: anchorFields[i]!.type,
                tsType: anchorFields[i]!.tsType ?? duckDBTypeScript(anchorFields[i]!.type, this.policy),
              }
            : {}),
          name: cte.columns?.[i] ?? field.name,
          relation: cte.name,
          nullable: cte.recursive || field.nullable,
        })),
      );
    }
    let fields: Field[] = [];
    if (statement.target) fields.push(...this.table(statement.target, statement.range));
    for (const relation of statement.relations) {
      const previous = [...fields],
        next = this.relation(relation, { ...scope, fields: [...parent.fields, ...fields] });
      if (relation.join === "right" || relation.join === "full" || relation.join === "positional")
        fields = fields.map((field) => ({ ...field, nullable: true }));
      if (relation.join !== "semi" && relation.join !== "anti") fields.push(...next);
      if (relation.condition)
        this.infer(relation.condition, { ...scope, fields: [...parent.fields, ...previous, ...next] }, bool(true));
      if (
        ["cross", "positional"].includes(relation.join ?? "") &&
        (relation.condition || relation.using || relation.natural)
      )
        this.error("CROSS/POSITIONAL joins do not accept conditions", relation.range, "TSQ201");
      if (["asof", "asof-left"].includes(relation.join ?? "") && !relation.using) {
        const inequalities: Expression[] = [];
        const visit = (expression: Expression): void => {
          if (expression.kind === "binary" && ["<", "<=", ">", ">="].includes(expression.value ?? ""))
            inequalities.push(expression);
          for (const child of duckDBExpressionChildren(expression)) visit(child);
        };
        if (relation.condition) visit(relation.condition);
        if (inequalities.length !== 1)
          this.error("ASOF JOIN requires exactly one ordering inequality", relation.range, "TSQ201");
      }

      if (relation.using || relation.natural) {
        const names =
          relation.using ??
          previous
            .map((field) => field.name)
            .filter((name) => next.some((field) => duckDBAsciiFold(name) === duckDBAsciiFold(field.name)));
        for (const name of names) {
          const left = previous.find(
              (field) => !field.usingHidden && duckDBAsciiFold(field.name) === duckDBAsciiFold(name),
            ),
            right = next.find((field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(name));
          if (!left || !right) {
            this.error(`USING column ${name} is missing`, relation.range);
            continue;
          }
          if (relation.join === "semi" || relation.join === "anti") continue;
          const merged: Field = {
            ...(relation.join === "right" ? right : left),
            name,
            type:
              relation.join === "full"
                ? commonDuckDBType(left.type, right.type)
                : relation.join === "right"
                  ? right.type
                  : left.type,
            nullable:
              relation.join === "full"
                ? left.nullable || right.nullable
                : relation.join === "right"
                  ? right.nullable
                  : left.nullable,
          };
          const {
            relation: _relation,
            schema: _schema,
            catalog: _catalog,
            tsType: _tsType,
            runtimeType: _runtimeType,
            ...unqualified
          } = merged;
          let inserted = false;
          fields = fields.flatMap((field) => {
            if (duckDBAsciiFold(field.name) !== duckDBAsciiFold(name)) return [field];
            if (!inserted) {
              inserted = true;
              return [unqualified, { ...field, usingHidden: true }];
            }
            return [{ ...field, usingHidden: true }];
          });
        }
      }
    }
    scope = {
      ...scope,
      fields: [...parent.fields, ...fields],
      windowNames: new Set((statement.windows ?? []).map((window) => duckDBAsciiFold(window.name))),
    };
    for (const window of statement.windows ?? []) {
      if (window.base && !scope.windowNames?.has(duckDBAsciiFold(window.base)))
        this.error(`Unknown named window ${window.base}`, statement.range, "TSQ101");
      for (const expression of window.expressions) this.infer(expression, scope);
    }

    if (statement.kind === "insert") {
      const target = fields.length ? fields : this.table(statement.target ?? [], statement.range),
        columns = statement.columns ?? target.map((field) => field.name);
      for (const row of statement.values ?? []) {
        if (row.length && row.length !== columns.length)
          this.error("INSERT value count differs from target columns", statement.range, "TSQ202");
        for (let i = 0; i < row.length; i++) {
          const column = target.find((field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(columns[i] ?? ""));
          if (!column) this.error(`Unknown INSERT column ${columns[i]}`, row[i]!.range);
          else this.infer(row[i]!, scope, column);
        }
      }
      if (statement.source) {
        const source = this.query(statement.source, scope);
        if (source.length !== columns.length)
          this.error("INSERT SELECT column count differs", statement.range, "TSQ202");
      }
    }
    for (const assignment of statement.assignments ?? []) {
      const target = fields.find((field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(assignment.name));
      if (!target) this.error(`Unknown UPDATE column ${assignment.name}`, statement.range);
      else this.infer(assignment.value, scope, target);
    }
    let output = this.project(statement.kind === "select" ? statement.projections : (statement.returning ?? []), scope);
    if (statement.where) this.infer(statement.where, scope, bool(true));
    this.validateGrouping(statement, scope);
    if (
      statement.group?.some(
        (expression) =>
          expression.kind === "call" &&
          ["cube", "rollup", "grouping_sets"].includes(expression.names?.at(-1)?.toLowerCase() ?? ""),
      )
    ) {
      const nullableKey = (expression: Expression): boolean =>
        !this.aggregate(expression) &&
        (expression.kind === "star" ||
          (expression.kind === "name" &&
            scope.fields.some(
              (field) => duckDBAsciiFold(field.name) === duckDBAsciiFold(expression.names?.at(-1) ?? ""),
            )) ||
          duckDBExpressionChildren(expression).some(nullableKey));
      output = output.map((field) =>
        statement.projections.some(
          (projection) =>
            projection.expression.range.start === field.range?.start && nullableKey(projection.expression),
        )
          ? { ...field, nullable: true }
          : field,
      );
    }

    for (const expression of [
      ...(statement.group ?? []).flatMap((expression) => this.groupingExpressions(expression)),
      ...(statement.distinctOn ?? []),
      ...(statement.order ?? []),
      ...(statement.having ? [statement.having] : []),
      ...(statement.qualify ? [statement.qualify] : []),
    ])
      this.infer(expression, scope);
    for (const expression of [statement.limit, statement.offset])
      if (expression) this.infer(expression, scope, { type: scalar("BIGINT"), nullable: false });
    if (statement.set) {
      const right = this.query(statement.set.right, parent);
      if (statement.set.byName) {
        const names = [
          ...output.map((x) => x.name),
          ...right
            .map((x) => x.name)
            .filter((name) => !output.some((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(name))),
        ];
        output = names.map((name) => {
          const l = output.find((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(name)),
            r = right.find((x) => duckDBAsciiFold(x.name) === duckDBAsciiFold(name));
          return { name, ...nullableUnion([l ?? nil, r ?? nil]) };
        });
      } else {
        if (output.length !== right.length) this.error("Set operation column count differs", statement.range, "TSQ202");
        output = output.map((field, i) => ({ ...nullableUnion([field, right[i] ?? nil]), name: field.name }));
      }
    }
    if (statement.kind === "describe")
      output = [
        { name: "column_name", type: scalar("VARCHAR"), nullable: false },
        { name: "column_type", type: scalar("VARCHAR"), nullable: false },
        { name: "null", type: scalar("VARCHAR"), nullable: false },
        { name: "key", type: scalar("VARCHAR"), nullable: true },
        { name: "default", type: scalar("VARCHAR"), nullable: true },
        { name: "extra", type: scalar("VARCHAR"), nullable: true },
      ];
    if (statement.kind === "summarize")
      output = [
        "column_name",
        "column_type",
        "min",
        "max",
        "approx_unique",
        "avg",
        "std",
        "q25",
        "q50",
        "q75",
        "count",
        "null_percentage",
      ].map((name) => ({
        name,
        type: scalar(["approx_unique", "count"].includes(name) ? "BIGINT" : "VARCHAR"),
        nullable: !["column_name", "column_type", "count"].includes(name),
      }));
    return output;
  }
  analyze(statement: Statement): DialectAnalysis {
    const fields = this.query(statement),
      names = new Set<string>(),
      columns: ResolvedColumn[] = fields.map((field) => {
        if (names.has(field.name)) this.error(`Duplicate output column ${field.name}`, statement.range, "TSQ203");
        names.add(field.name);
        return {
          name: field.name,
          tsType: field.tsType ?? duckDBTypeScript(field.type, this.policy),
          nullable: field.nullable,
          databaseType: formatDuckDBType(field.type),
          runtimeType: field.runtimeType ?? duckDBRuntimeType(field.type, this.policy),
          range: field.range ?? statement.range,
        };
      });
    const parameters: ResolvedParameter[] = [...this.parameters.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, { value }]) => ({
        index,
        tsType: value.tsType ?? duckDBTypeScript(value.type, this.policy),
        nullable: value.nullable,
        databaseType: formatDuckDBType(value.type),
        runtimeType: duckDBRuntimeType(value.type, this.policy),
      }));
    const writes = ["insert", "update", "delete", "merge", "create"].includes(statement.kind),
      evidence = [{ kind: "syntax" as const, description: "DuckDB statement AST", range: statement.range }];
    const expands = (expression: Expression): boolean =>
      (expression.kind === "call" && expression.names?.at(-1)?.toLowerCase() === "unnest") ||
      duckDBExpressionChildren(expression).some(expands);
    const scalarResult =
      statement.kind === "select" &&
      !statement.relations.length &&
      !statement.set &&
      !statement.projections.some((projection) => expands(projection.expression));
    const zero = statement.limit?.kind === "literal" && statement.limit.value === "0";
    return {
      columns,
      parameters,
      diagnostics: this.diagnostics,
      resultKind: writes && !statement.returning ? "command" : "rows",
      semantics: defineQuerySemantics({
        version: 1,
        operation: { value: this.effect, evidence },
        dependencies: this.dependencies,
        cardinality: {
          minimum:
            scalarResult && !zero && !statement.where && !statement.having && !statement.qualify && !statement.offset
              ? 1
              : 0,
          maximum: zero ? 0 : scalarResult || statement.limit?.value === "1" ? 1 : "many",
          evidence,
        },
        volatility: { value: this.volatile ? "volatile" : this.unknownVolatility ? "unknown" : "stable", evidence },
        locking: { value: this.effect === "read" ? "none" : "unknown", evidence },
        connectionAffinity: {
          value: this.sessionAffinity
            ? "session"
            : this.effect === "read"
              ? "none"
              : this.effect === "unknown"
                ? "unknown"
                : "transaction",
          evidence,
        },
        capabilities: [...(statement.set ? ["setOperations"] : []), ...(statement.returning ? ["returning"] : [])],
      }),
    };
  }
}
export function resolveDuckDBStatement(
  statement: Statement,
  snapshot: DuckDBSchemaSnapshot,
  policy: DuckDBTypePolicy,
): DialectAnalysis {
  return new DuckDBResolver(snapshot, policy).analyze(statement);
}
