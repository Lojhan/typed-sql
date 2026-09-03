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

function arrayType(databaseType: string): { readonly base: string; readonly dimensions: number } {
  let end = databaseType.length;
  while (end >= 2 && databaseType[end - 2] === "[" && databaseType[end - 1] === "]") end -= 2;
  return { base: databaseType.slice(0, end), dimensions: (databaseType.length - end) / 2 };
}

function snapshotType(databaseType: string, schema?: SchemaSnapshot) {
  if (schema?.formatVersion !== 2) return undefined;
  const target = withoutModifiers(normalized(databaseType));
  return Object.values(schema.types).find((type) => {
    const qualified = type.schema === undefined ? type.name : `${type.schema}.${type.name}`;
    return [type.databaseType, type.identity, qualified].some(
      (identity) => withoutModifiers(normalized(identity)) === target,
    );
  });
}

export function isKnownPostgresType(databaseType: string, schema?: SchemaSnapshot): boolean {
  const type = withoutModifiers(arrayType(normalized(databaseType)).base);
  if (postgresCatalogTypeMapping(type, schema) !== undefined) return true;
  if (snapshotType(type, schema) !== undefined) return true;
  return schema?.enums?.[type] !== undefined || schema?.domains?.[type] !== undefined;
}

export function mapPostgresType(databaseType: string, policy: PostgresTypePolicy, schema?: SchemaSnapshot): string {
  const { base: unmodifiedType, dimensions } = arrayType(normalized(databaseType));
  const type = withoutModifiers(unmodifiedType);
  const catalogMapping = postgresCatalogTypeMapping(type, schema);
  const snapshotMapping = snapshotType(unmodifiedType, schema);
  let mapped: string;
  if (catalogMapping === "number") mapped = "number";
  else if (catalogMapping === "bigint") mapped = policy.bigint;
  else if (catalogMapping === "numeric") mapped = policy.numeric;
  else if (catalogMapping === "boolean") mapped = "boolean";
  else if (catalogMapping === "string") mapped = "string";
  else if (catalogMapping === "date") mapped = policy.date;
  else if (catalogMapping === "json") mapped = policy.json;
  else if (catalogMapping === "bytes") mapped = "Uint8Array";
  else if (snapshotMapping !== undefined) mapped = snapshotMapping.tsType;
  else if (schema?.domains?.[unmodifiedType] !== undefined || schema?.domains?.[type] !== undefined)
    mapped = (schema.domains[unmodifiedType] ?? schema.domains[type]!).tsType;
  else if (schema?.enums?.[unmodifiedType] !== undefined || schema?.enums?.[type] !== undefined) {
    const values = schema.enums[unmodifiedType] ?? schema.enums[type]!;
    mapped = policy.enums === "string" ? "string" : values.map((value) => JSON.stringify(value)).join(" | ");
  } else mapped = policy.unknown;
  return dimensions === 0 ? mapped : `${"readonly (".repeat(dimensions)}${mapped}${")[]".repeat(dimensions)}`;
}
