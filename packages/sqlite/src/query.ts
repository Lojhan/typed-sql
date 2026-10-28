import type { RuntimeValueType, SqlRenderer } from "@typed-sql/core";
import { defaultSqliteTypePolicy, type SqliteTypePolicy, sqliteFlexibleType } from "./type-policy.js";

export { sql } from "@typed-sql/core";

export const sqliteRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `"${identifier.replaceAll('"', '""')}"`,
});

export function sqliteRuntimeValueType(
  value: { readonly databaseType?: string; readonly tsType: string; readonly nullable: boolean },
  policy: SqliteTypePolicy = defaultSqliteTypePolicy,
): RuntimeValueType {
  if (value.tsType === sqliteFlexibleType(policy) && policy.flexible === "union")
    return { union: [...new Set<RuntimeValueType>([policy.integer, "number", "string", "bytes"])] };
  switch (value.tsType) {
    case "number":
    case "bigint":
    case "boolean":
    case "string":
      return value.tsType;
    case "Date":
      return "date";
    case "Uint8Array":
      return "bytes";
    default:
      return "unknown";
  }
}
