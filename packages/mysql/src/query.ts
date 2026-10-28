import type { RuntimeValueType, SqlRenderer } from "@typed-sql/core";
import { defaultMySqlTypePolicy, type MySqlTypePolicy, mySqlEnumValues } from "./type-policy.js";

export { sql } from "@typed-sql/core";

export const mysqlRenderer: SqlRenderer = Object.freeze({
  placeholder: () => "?",
  quoteIdentifier: (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``,
});

export function mysqlRuntimeValueType(
  value: { readonly databaseType?: string; readonly tsType: string; readonly nullable: boolean },
  _policy: MySqlTypePolicy = defaultMySqlTypePolicy,
): RuntimeValueType {
  if (value.databaseType !== undefined && mySqlEnumValues(value.databaseType) !== undefined) return "string";
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
