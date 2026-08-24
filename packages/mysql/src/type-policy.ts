import type { SchemaSnapshot } from "@typed-sql/schema";

export interface MySqlTypePolicy {
  readonly bigint: "bigint" | "string" | "number";
  readonly decimal: "string" | "number" | "Decimal";
  readonly date: "Date" | "string";
  readonly json: "unknown" | "JsonValue" | "string";
  readonly tinyint1: "boolean" | "number";
  readonly unknown: "unknown" | "never";
}

export const defaultMySqlTypePolicy: MySqlTypePolicy = Object.freeze({
  bigint: "bigint",
  decimal: "string",
  date: "Date",
  json: "unknown",
  tinyint1: "boolean",
  unknown: "unknown",
});

const normalized = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, " ");
const baseType = (value: string): string => normalized(value).replace(/\s+unsigned$/u, "").replace(/\(.*/u, "");

function enumValues(databaseType: string): readonly string[] | undefined {
  const match = /^enum\((.*)\)$/iu.exec(databaseType.trim());
  if (match?.[1] === undefined) return undefined;
  const values: string[] = [];
  const pattern = /'((?:''|\\.|[^'])*)'/gu;
  for (const value of match[1].matchAll(pattern)) values.push(value[1]!.replaceAll("''", "'").replace(/\\(.)/gu, "$1"));
  return values;
}

export function isKnownMySqlType(databaseType: string, schema?: SchemaSnapshot): boolean {
  const type = baseType(databaseType);
  return [
    "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "bit",
    "boolean", "bool", "char", "varchar", "tinytext", "text", "mediumtext", "longtext", "binary", "varbinary", "tinyblob", "blob",
    "mediumblob", "longblob", "date", "datetime", "timestamp", "time", "year", "json", "enum", "set",
  ].includes(type) || schema?.domains?.[type] !== undefined;
}

export function mapMySqlType(databaseType: string, policy: MySqlTypePolicy, schema?: SchemaSnapshot): string {
  const type = baseType(databaseType);
  const values = enumValues(databaseType);
  if (values !== undefined) return values.map((value) => JSON.stringify(value)).join(" | ") || "never";
  if (type === "tinyint" && /^tinyint\(1\)/iu.test(databaseType)) return policy.tinyint1;
  if (["tinyint", "smallint", "mediumint", "int", "integer", "float", "double", "real", "bit", "year"].includes(type)) return "number";
  if (type === "bigint") return policy.bigint;
  if (type === "decimal" || type === "numeric") return policy.decimal;
  if (type === "boolean" || type === "bool") return "boolean";
  if (["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "set", "time"].includes(type)) return "string";
  if (["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"].includes(type)) return "Uint8Array";
  if (["date", "datetime", "timestamp"].includes(type)) return policy.date;
  if (type === "json") return policy.json;
  return schema?.domains?.[type]?.tsType ?? policy.unknown;
}
