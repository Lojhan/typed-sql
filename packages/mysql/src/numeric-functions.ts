import type { SchemaSnapshot } from "@typed-sql/schema";
import type { MySqlCatalogProvider } from "./catalog/provider.js";
import type { Expression } from "./parser/index.js";
import type { MySqlTypePolicy } from "./type-policy.js";

export type MySqlNumericRule = "numeric-absolute" | "numeric-round" | "numeric-integral";
interface NumericValue {
  readonly tsType: string;
  readonly nullable: boolean;
  readonly databaseType?: string;
  readonly unsigned?: boolean;
}
interface DecimalShape {
  readonly precision: number;
  readonly scale: number;
}

/** MySQL's exact decimal reader keeps one zero before the first nonzero integer digit. */
function literalDecimal(text: string): DecimalShape {
  const [integer = "", fraction = ""] = text.replace(/^0+(?=0)/u, "").split(".");
  return { precision: Math.max(1, integer.length + fraction.length), scale: fraction.length };
}

export function mySqlNumericLiteralType(text: string): string | undefined {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)) return undefined;
  if (/[eE]/u.test(text)) return Number.isFinite(Number(text)) ? "double" : undefined;
  if (text.includes(".")) {
    const shape = literalDecimal(text);
    return shape.precision <= 65 && shape.scale <= 30 ? `decimal(${shape.precision},${shape.scale})` : undefined;
  }
  const digits = text.replace(/^0+/u, "") || "0";
  if (digits.length > 65) return undefined;
  const value = BigInt(digits);
  if (value > 18_446_744_073_709_551_615n) return `decimal(${digits.length},0)`;
  if (value > 9_223_372_036_854_775_807n) return "bigint unsigned";
  return value > 2_147_483_647n ? "bigint" : "int";
}

function decimalShape(databaseType: string): DecimalShape | undefined {
  const match = /^(?:decimal|numeric|dec|fixed)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)(?:\s+unsigned)?$/u.exec(databaseType);
  if (!match) return undefined;
  const precision = Number(match[1]),
    scale = Number(match[2]);
  return precision >= 1 && precision <= 65 && scale >= 0 && scale <= precision && scale <= 30
    ? { precision, scale }
    : undefined;
}

function constantScale(expression: Expression | undefined): number | undefined {
  if (!expression) return 0;
  if (expression.kind === "unary" && ["+", "-"].includes(expression.operator)) {
    const value = constantScale(expression.expression);
    return value === undefined ? undefined : expression.operator === "-" ? -value : value;
  }
  if (expression.kind !== "literal") return undefined;
  if (expression.value === null) return 0;
  if (typeof expression.value === "boolean") return expression.value ? 1 : 0;
  if (typeof expression.value !== "number" || !Number.isSafeInteger(expression.value)) return undefined;
  return expression.value;
}

/** Grammar-owned numeric result rules; overload names and argument bounds are catalog inputs. */
export function resolveMySqlNumeric(
  rule: MySqlNumericRule,
  values: readonly NumericValue[],
  expressions: readonly Expression[],
  policy: MySqlTypePolicy,
  schema: SchemaSnapshot,
  catalog: MySqlCatalogProvider,
): NumericValue & { reason?: string } {
  const input = values[0],
    nullable = values.some((value) => value.nullable),
    unknown = (reason: string) => ({ tsType: "unknown", nullable: true, reason });
  if (!input) return unknown("Numeric function requires an input");
  const name = input.databaseType ? catalog.type(input.databaseType, schema)?.name : undefined,
    category = input.databaseType ? catalog.type(input.databaseType, schema)?.category : undefined;
  if (category === "spatial" || category === "vector")
    return unknown("Spatial and VECTOR inputs are not numeric operands");
  const integer = category === "numeric-integer" || category === "boolean" || name === "bit" || name === "year";
  if (integer)
    return {
      tsType: policy.bigint,
      nullable,
      databaseType: `bigint${input.unsigned ? " unsigned" : ""}`,
      unsigned: input.unsigned === true,
    };
  if (category === "numeric-decimal") {
    const shape = decimalShape(input.databaseType!);
    if (rule === "numeric-integral") {
      if (!shape) return unknown("Integral rounding requires decimal precision and scale");
      const precision = Math.min(65, shape.precision - shape.scale + (shape.scale > 0 ? 1 : 0));
      // The vendor reserves a sign digit and requires max_length < 20 for BIGINT.
      return precision < 19
        ? { tsType: policy.bigint, nullable, databaseType: "bigint", unsigned: false }
        : { tsType: policy.decimal, nullable, databaseType: `decimal(${precision},0)`, unsigned: false };
    }
    let result = shape;
    if (rule === "numeric-round" && shape) {
      const requested = constantScale(expressions[1]);
      if (requested === undefined) result = undefined;
      else {
        const scale = Math.max(0, Math.min(30, requested)),
          precision =
            scale < shape.scale || requested <= 0
              ? Math.min(65, Math.max(1, shape.precision - (shape.scale - Math.min(shape.scale, scale)) + 1))
              : shape.precision;
        result = { precision, scale: Math.min(shape.scale, scale) };
      }
    }
    return {
      tsType: policy.decimal,
      nullable,
      databaseType: result
        ? `decimal(${result.precision},${result.scale})${input.unsigned ? " unsigned" : ""}`
        : "decimal",
      unsigned: input.unsigned === true,
    };
  }
  if (category || (expressions[0]?.kind === "literal" && expressions[0].value === null))
    return { tsType: "number", nullable, databaseType: "double" };
  return unknown("Numeric input type is unavailable");
}
