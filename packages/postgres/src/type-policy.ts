import type { SchemaSnapshot } from "@typed-sql/schema";
import { postgresCatalogTypeMapping } from "./catalog/index.js";

export interface PostgresTypePolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly numeric: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
  readonly enums: "string-union" | "string";
  readonly unknown: "unknown" | "never";
}

export const defaultPostgresTypePolicy: PostgresTypePolicy = Object.freeze({
  bigint: "bigint",
  numeric: "string",
  date: "Date",
  json: "unknown",
  enums: "string-union",
  unknown: "unknown",
});

const normalized = (databaseType: string): string => databaseType.trim().toLowerCase().replace(/\s+/g, " ");
const withoutModifiers = (databaseType: string): string => databaseType.replace(/\(\d+(?:,\s*\d+)?\)/g, "");

export function isKnownPostgresType(databaseType: string, schema?: SchemaSnapshot): boolean {
  const type = withoutModifiers(normalized(databaseType).replace(/\[\]$/, ""));
  if (postgresCatalogTypeMapping(type, schema) !== undefined) return true;
  return schema?.enums?.[type] !== undefined || schema?.domains?.[type] !== undefined;
}

export function mapPostgresType(databaseType: string, policy: PostgresTypePolicy, schema?: SchemaSnapshot): string {
  const normalizedType = normalized(databaseType);
  const array = normalizedType.endsWith("[]");
  const unmodifiedType = normalizedType.replace(/\[\]$/, "");
  const type = withoutModifiers(unmodifiedType);
  const catalogMapping = postgresCatalogTypeMapping(type, schema);
  let mapped: string;
  if (catalogMapping === "number") mapped = "number";
  else if (catalogMapping === "bigint") mapped = policy.bigint;
  else if (catalogMapping === "numeric") mapped = policy.numeric;
  else if (catalogMapping === "boolean") mapped = "boolean";
  else if (catalogMapping === "string") mapped = "string";
  else if (catalogMapping === "date") mapped = policy.date;
  else if (catalogMapping === "json") mapped = policy.json;
  else if (catalogMapping === "bytes") mapped = "Uint8Array";
  else if (schema?.domains?.[unmodifiedType] !== undefined || schema?.domains?.[type] !== undefined)
    mapped = (schema.domains[unmodifiedType] ?? schema.domains[type]!).tsType;
  else if (schema?.enums?.[unmodifiedType] !== undefined || schema?.enums?.[type] !== undefined) {
    const values = schema.enums[unmodifiedType] ?? schema.enums[type]!;
    mapped = policy.enums === "string" ? "string" : values.map((value) => JSON.stringify(value)).join(" | ");
  } else mapped = policy.unknown;
  return array ? `readonly (${mapped})[]` : mapped;
}
