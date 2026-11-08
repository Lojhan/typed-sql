import type { RuntimeValueType } from "@typed-sql/core";
import { brandBaseType } from "@typed-sql/core";
import { parseSqlServerNativeType } from "./native-types.js";
export interface SqlServerTypePolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly decimal: "string" | "number" | "Decimal";
  /** Exact canonical strings preserve 100ns; datetimeoffset is normalized to UTC. */
  readonly temporal: "string" | "Date";
  readonly json: "string" | "parsed";
  readonly unknown: "unknown" | "never";
}
export const defaultSqlServerTypePolicy: SqlServerTypePolicy = Object.freeze({
  bigint: "bigint",
  decimal: "string",
  temporal: "string",
  json: "string",
  unknown: "unknown",
});
export function validateSqlServerTypePolicy(value: SqlServerTypePolicy): SqlServerTypePolicy {
  if (
    !["bigint", "string", "number"].includes(value.bigint) ||
    !["string", "number", "Decimal"].includes(value.decimal) ||
    !["string", "Date"].includes(value.temporal) ||
    !["string", "parsed"].includes(value.json) ||
    !["unknown", "never"].includes(value.unknown)
  )
    throw new TypeError("Invalid SQL Server type policy");
  return Object.freeze({ ...value });
}
export function mapSqlServerType(
  databaseType: string,
  policy: SqlServerTypePolicy = defaultSqlServerTypePolicy,
): string {
  const type = parseSqlServerNativeType(databaseType);
  if (!type) return policy.unknown;
  const name = type.name;
  if (["tinyint", "smallint", "int", "real", "float"].includes(name)) return "number";
  if (name === "bigint") return policy.bigint;
  if (["decimal", "money", "smallmoney"].includes(name)) return policy.decimal;
  if (name === "bit") return "boolean";
  if (["date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset"].includes(name))
    return policy.temporal === "Date" ? "Date" : "string";
  if (["binary", "varbinary", "image", "rowversion"].includes(name)) return "Uint8Array";
  if (name === "json") return policy.json === "parsed" ? "JsonValue" : "string";
  if (name === "sql_variant") return policy.unknown;
  return "string";
}
export function sqlServerRuntimeValueType(
  value: { readonly tsType: string; readonly databaseType?: string; readonly nullable: boolean },
  policy: SqlServerTypePolicy = defaultSqlServerTypePolicy,
): RuntimeValueType {
  const base = brandBaseType(value.tsType);
  if (base) return base;
  switch (value.tsType) {
    case "never":
    case "unknown":
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return value.tsType;
    case "Date":
      return "date";
    case "Uint8Array":
      return "bytes";
    case "JsonValue":
      return { json: { shape: { kind: "unknown" }, representation: policy.json === "parsed" ? "parsed" : "text" } };
    default:
      return "unknown";
  }
}
