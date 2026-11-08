import type { SqlRenderer } from "@typed-sql/core";

export const postgresRenderer: SqlRenderer = Object.freeze({
  placeholder(index: number): string {
    if (!Number.isInteger(index) || index < 1) throw new RangeError("PostgreSQL parameter indexes start at 1");
    return `$${index}`;
  },
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
});
