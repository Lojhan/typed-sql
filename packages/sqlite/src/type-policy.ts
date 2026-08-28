import type { SchemaSnapshot } from "@typed-sql/schema";

export type SqliteAffinity = "integer" | "text" | "blob" | "real" | "numeric";

export interface SqliteTypePolicy {
  readonly integer: "bigint" | "number";
  readonly flexible: "union" | "unknown";
  readonly unknown: "unknown" | "never";
}

export const defaultSqliteTypePolicy: SqliteTypePolicy = Object.freeze({
  integer: "bigint",
  flexible: "union",
  unknown: "unknown",
});

export function sqliteAffinity(databaseType: string): SqliteAffinity {
  const type = databaseType.trim().toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "text";
  if (type.length === 0 || type.includes("BLOB")) return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "real";
  return "numeric";
}

export function isKnownStrictSqliteType(databaseType: string): boolean {
  return ["ANY", "BLOB", "INT", "INTEGER", "REAL", "TEXT"].includes(databaseType.trim().toUpperCase());
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
  switch (databaseType.trim().toUpperCase()) {
    case "INT":
    case "INTEGER":
      return policy.integer;
    case "REAL":
      return "number";
    case "TEXT":
      return "string";
    case "BLOB":
      return "Uint8Array";
    case "ANY":
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
