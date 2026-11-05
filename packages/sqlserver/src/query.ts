import type { RuntimeValueType, SqlRenderer } from "@typed-sql/core";

export type { JsonValue } from "@typed-sql/core";
export { sql } from "@typed-sql/core";
export { sqlServerRuntimeValueType } from "./type-policy.js";
/** Driver-neutral statement rendering. The ODBC adapter selects its own positional renderer. */
export const sqlServerRenderer: SqlRenderer = Object.freeze({
  placeholder(index: number) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 2100)
      throw new RangeError("SQL Server supports at most 2100 bound parameters");
    return `@__typed_sql_${index}`;
  },
  quoteIdentifier(identifier: string) {
    if (!identifier || identifier.length > 128 || identifier.includes("\0"))
      throw new TypeError("SQL Server identifiers require 1–128 UTF-16 units without NUL");
    return `[${identifier.replaceAll("]", "]]")}]`;
  },
});
export function normalizeSqlServerValue(value: unknown, type: RuntimeValueType): unknown {
  if (type === "bigint" && typeof value === "string") {
    if (!/^-?\d+$/u.test(value)) throw new TypeError("Invalid SQL Server integer text");
    return BigInt(value);
  }
  if (type === "number" && typeof value === "string") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value))
      throw new TypeError("Invalid SQL Server numeric text");
    const number = Number(value);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
      throw new RangeError("SQL Server number exceeds the requested precision");
    return number;
  }
  if (type === "date" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid SQL Server date value");
    return date;
  }
  if (type === "bytes" && value instanceof Uint8Array) return Uint8Array.from(value);
  return value;
}

export type { JsonInput, Query, QueryValuePlan } from "@typed-sql/core";
export { defineQueryValuePlan, defineQueryValuePlanSelector, withQueryValuePlan } from "@typed-sql/core";
/** Portable renderer used by compiler-generated conditional and repeated-fragment selectors. */
export { sqlServerRenderer as renderer };
