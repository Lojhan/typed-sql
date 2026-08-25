import type { SchemaSnapshot } from "@typed-sql/schema";

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
  if (
    [
      "smallint",
      "int2",
      "integer",
      "int",
      "int4",
      "bigint",
      "int8",
      "numeric",
      "decimal",
      "real",
      "float4",
      "double precision",
      "float8",
      "boolean",
      "bool",
      "text",
      "varchar",
      "character varying",
      "char",
      "uuid",
      "date",
      "timestamp",
      "timestamp without time zone",
      "timestamptz",
      "timestamp with time zone",
      "json",
      "jsonb",
      "bytea",
    ].includes(type)
  )
    return true;
  return schema?.enums?.[type] !== undefined || schema?.domains?.[type] !== undefined;
}

export function mapPostgresType(databaseType: string, policy: PostgresTypePolicy, schema?: SchemaSnapshot): string {
  const normalizedType = normalized(databaseType);
  const array = normalizedType.endsWith("[]");
  const unmodifiedType = normalizedType.replace(/\[\]$/, "");
  const type = withoutModifiers(unmodifiedType);
  let mapped: string;
  if (["smallint", "int2", "integer", "int", "int4", "real", "float4", "double precision", "float8"].includes(type))
    mapped = "number";
  else if (["bigint", "int8"].includes(type)) mapped = policy.bigint;
  else if (["numeric", "decimal"].includes(type)) mapped = policy.numeric;
  else if (["boolean", "bool"].includes(type)) mapped = "boolean";
  else if (["text", "varchar", "character varying", "char", "uuid"].includes(type)) mapped = "string";
  else if (
    ["date", "timestamp", "timestamp without time zone", "timestamptz", "timestamp with time zone"].includes(type)
  )
    mapped = policy.date;
  else if (["json", "jsonb"].includes(type)) mapped = policy.json;
  else if (type === "bytea") mapped = "Uint8Array";
  else if (schema?.domains?.[unmodifiedType] !== undefined || schema?.domains?.[type] !== undefined)
    mapped = (schema.domains[unmodifiedType] ?? schema.domains[type]!).tsType;
  else if (schema?.enums?.[unmodifiedType] !== undefined || schema?.enums?.[type] !== undefined) {
    const values = schema.enums[unmodifiedType] ?? schema.enums[type]!;
    mapped = policy.enums === "string" ? "string" : values.map((value) => JSON.stringify(value)).join(" | ");
  } else mapped = policy.unknown;
  return array ? `readonly (${mapped})[]` : mapped;
}
