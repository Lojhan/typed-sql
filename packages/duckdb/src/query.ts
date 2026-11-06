import type { SqlRenderer } from "@typed-sql/core";

export type { JsonInput, Query, QueryValuePlan } from "@typed-sql/core";
export { defineQueryValuePlan, defineQueryValuePlanSelector, sql, withQueryValuePlan } from "@typed-sql/core";
export const duckdbRenderer: SqlRenderer = Object.freeze({
  placeholder(index: number): string {
    if (!Number.isSafeInteger(index) || index < 1 || index > 65535)
      throw new RangeError("DuckDB parameter index must be 1–65535");
    return `$${index}`;
  },
  quoteIdentifier(name: string): string {
    if (!name || name.includes("\0")) throw new TypeError("Invalid DuckDB identifier");
    return `"${name.replaceAll('"', '""')}"`;
  },
});
export { duckdbRenderer as renderer };
