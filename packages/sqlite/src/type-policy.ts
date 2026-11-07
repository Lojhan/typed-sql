import type { SchemaSnapshot } from "@typed-sql/schema";
import { type SqliteAffinity, sqliteAffinity } from "./catalog/coercions.js";
import { strictTypeMappings } from "./catalog/generated/types.js";

export type { SqliteAffinity };
export { sqliteAffinity };

export interface SqliteTypePolicy {
  /** Parsed JSON requires a compiled runtime-validation plan; SQL JSONB remains binary. */
  readonly json?: "string" | "parsed";
  readonly integer: "bigint" | "number";
  readonly flexible: "union" | "unknown";
  readonly unknown: "unknown" | "never";
}

export const defaultSqliteTypePolicy: SqliteTypePolicy = Object.freeze({
  integer: "bigint",
  flexible: "union",
  unknown: "unknown",
});

export function isKnownStrictSqliteType(databaseType: string): boolean {
  return Object.hasOwn(strictTypeMappings, databaseType.trim().toUpperCase());
}

export function isKnownSqliteType(databaseType: string): boolean {
  return databaseType.trim().length > 0;
}

export function sqliteFlexibleType(policy: SqliteTypePolicy): string {
  return policy.flexible === "unknown"
    ? "unknown"
    : [...new Set([policy.integer, "number", "string", "Uint8Array"])].join(" | ");
}

export function mapSqliteType(
  databaseType: string,
  policy: SqliteTypePolicy,
  options: { readonly strict?: boolean; readonly schema?: SchemaSnapshot } = {},
): string {
  if (!options.strict) {
    return sqliteFlexibleType(policy);
  }
  switch (strictTypeMappings[databaseType.trim().toUpperCase()]) {
    case "integer":
      return policy.integer;
    case "number":
      return "number";
    case "string":
      return "string";
    case "bytes":
      return "Uint8Array";
    case "flexible":
      return sqliteFlexibleType(policy);
    default:
      return options.schema?.domains?.[databaseType.toLowerCase()]?.tsType ?? policy.unknown;
  }
}

export function mapSqliteCastType(databaseType: string, policy: SqliteTypePolicy): string {
  switch (sqliteAffinity(databaseType)) {
    case "integer":
      return policy.integer;
    case "real":
      return "number";
    case "text":
      return "string";
    case "blob":
      return "Uint8Array";
    case "numeric":
      return [...new Set([policy.integer, "number"])].join(" | ");
  }
}
