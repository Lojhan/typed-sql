import type { RuntimeValueType } from "@typed-sql/core";
import { type DuckDBType, formatDuckDBType, parseDuckDBType } from "./native-types.js";
export interface DuckDBTypePolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly decimal: "string";
  readonly temporal: "string";
  readonly json: "string" | "unknown" | "JsonValue";
  readonly enums: "string-union" | "string";
  readonly unknown: "unknown" | "never";
}
export const defaultDuckDBTypePolicy: DuckDBTypePolicy = Object.freeze({
  bigint: "bigint",
  decimal: "string",
  temporal: "string",
  json: "string",
  enums: "string-union",
  unknown: "unknown",
});
const numeric = new Set(["TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER", "FLOAT", "DOUBLE"]);
const wide = new Set(["BIGINT", "UBIGINT", "HUGEINT", "UHUGEINT", "BIGNUM"]);
const temporal = new Set([
  "DATE",
  "TIME",
  "TIME_NS",
  "TIMETZ",
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMPTZ",
  "TIMESTAMPTZ_NS",
]);
export const DUCKDB_SCALAR_TYPES: ReadonlySet<string> = new Set([
  ...numeric,
  ...wide,
  ...temporal,
  "DECIMAL",
  "VARCHAR",
  "BOOLEAN",
  "BLOB",
  "BIT",
  "UUID",
  "JSON",
  "INTERVAL",
  "NULL",
]);
export function validateDuckDBTypePolicy(policy: DuckDBTypePolicy): DuckDBTypePolicy {
  if (
    !["bigint", "string", "number"].includes(policy.bigint) ||
    policy.decimal !== "string" ||
    policy.temporal !== "string" ||
    !["string", "unknown", "JsonValue"].includes(policy.json) ||
    !["string-union", "string"].includes(policy.enums) ||
    !["unknown", "never"].includes(policy.unknown)
  )
    throw new TypeError("Invalid DuckDB type policy");
  return Object.freeze({ ...policy });
}
export function isKnownDuckDBType(type: DuckDBType): boolean {
  switch (type.kind) {
    case "scalar":
      return DUCKDB_SCALAR_TYPES.has(type.name);
    case "enum":
      return true;
    case "list":
    case "array":
      return isKnownDuckDBType(type.element);
    case "map":
      return isKnownDuckDBType(type.key) && isKnownDuckDBType(type.value);
    case "tuple":
      return type.elements.every(isKnownDuckDBType);
    default:
      return type.fields.every((field) => isKnownDuckDBType(field.type));
  }
}
const nullable = (text: string): string => `${text} | null`;
export function duckDBTypeScript(type: DuckDBType, policy: DuckDBTypePolicy = defaultDuckDBTypePolicy): string {
  switch (type.kind) {
    case "enum":
      return policy.enums === "string" ? "string" : type.values.map((value) => JSON.stringify(value)).join(" | ");
    case "list":
      return `readonly (${nullable(duckDBTypeScript(type.element, policy))})[]`;
    case "array":
      return type.length <= 64
        ? `readonly [${Array.from({ length: type.length }, () => nullable(duckDBTypeScript(type.element, policy))).join(", ")}]`
        : `readonly (${nullable(duckDBTypeScript(type.element, policy))})[]`;
    case "struct":
      return `{ ${type.fields.map((field) => `readonly ${JSON.stringify(field.name)}: ${nullable(duckDBTypeScript(field.type, policy))};`).join(" ")} }`;
    case "tuple":
      return `readonly [${type.elements.map((element) => nullable(duckDBTypeScript(element, policy))).join(", ")}]`;
    case "map":
      return `readonly (readonly [${duckDBTypeScript(type.key, policy)}, ${nullable(duckDBTypeScript(type.value, policy))}])[]`;
    case "union":
      return type.fields
        .map(
          (field) =>
            `{ readonly tag: ${JSON.stringify(field.name)}; readonly value: ${nullable(duckDBTypeScript(field.type, policy))}; }`,
        )
        .join(" | ");
    case "scalar": {
      if (numeric.has(type.name)) return "number";
      if (wide.has(type.name)) return policy.bigint;
      if (temporal.has(type.name) || ["DECIMAL", "VARCHAR", "UUID", "BIT"].includes(type.name)) return "string";
      if (type.name === "BOOLEAN") return "boolean";
      if (type.name === "BLOB") return "Uint8Array";
      if (type.name === "JSON") return policy.json;
      if (type.name === "INTERVAL")
        return "{ readonly months: number; readonly days: number; readonly micros: bigint; }";
      if (type.name === "NULL") return "never";
      return policy.unknown;
    }
  }
}
export function mapDuckDBType(databaseType: string, policy: DuckDBTypePolicy = defaultDuckDBTypePolicy): string {
  return duckDBTypeScript(parseDuckDBType(databaseType), policy);
}
export function duckDBRuntimeType(
  type: DuckDBType,
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
): RuntimeValueType {
  const field = (child: DuckDBType, nullable = true) => ({ type: duckDBRuntimeType(child, policy), nullable });
  switch (type.kind) {
    case "enum":
      return policy.enums === "string" ? "string" : { union: type.values.map((literal) => ({ literal })) };
    case "list":
      return { array: duckDBRuntimeType(type.element, policy), elementNullable: true };
    case "array":
      return { array: duckDBRuntimeType(type.element, policy), elementNullable: true, length: type.length };
    case "struct":
      return { object: Object.fromEntries(type.fields.map((item) => [item.name, field(item.type)])) };
    case "tuple":
      return { tuple: type.elements.map((child) => field(child)) };
    case "map":
      return { array: { tuple: [field(type.key, false), field(type.value)] }, elementNullable: false };
    case "union":
      return {
        union: type.fields.map((item) => ({
          object: { tag: { type: { literal: item.name }, nullable: false }, value: field(item.type) },
        })),
      };
    case "scalar": {
      const mapped = duckDBTypeScript(type, policy);
      if (["number", "bigint", "boolean", "string", "never"].includes(mapped))
        return mapped as "number" | "bigint" | "boolean" | "string" | "never";
      if (type.name === "BLOB") return "bytes";
      if (type.name === "INTERVAL")
        return {
          object: {
            months: { type: "number", nullable: false },
            days: { type: "number", nullable: false },
            micros: { type: "bigint", nullable: false },
          },
        };
      return "unknown";
    }
  }
}
export function duckDBRuntimeValueType(
  value: { readonly databaseType?: string; readonly tsType: string; readonly nullable: boolean },
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
): RuntimeValueType {
  if (value.databaseType === undefined) return "unknown";
  return duckDBRuntimeType(parseDuckDBType(value.databaseType), policy);
}
export function duckDBTypeIdentity(type: DuckDBType): string {
  return `duckdb:${formatDuckDBType(type)}`;
}
