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
