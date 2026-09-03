import type { SchemaSnapshot } from "@typed-sql/schema";
import { mySqlCatalogType } from "./catalog/index.js";

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

function isTypeWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function normalized(value: string): string {
  const input = value.trim().toLowerCase();
  let output = "";
  let pendingSpace = false;
  for (const char of input) {
    if (isTypeWhitespace(char)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) output += " ";
    output += char;
    pendingSpace = false;
  }
  return output;
}

function baseType(value: string): string {
  let type = normalized(value);
  if (type.endsWith(" unsigned")) type = type.slice(0, -" unsigned".length);
  const parameters = type.indexOf("(");
  return parameters === -1 ? type : type.slice(0, parameters);
}

function mySqlCollectionValues(databaseType: string, kind: "enum" | "set"): readonly string[] | undefined {
  const type = databaseType.trim();
  const prefix = `${kind}(`;
  if (type.slice(0, prefix.length).toLowerCase() !== prefix || !type.endsWith(")")) return undefined;
  const body = type.slice(prefix.length, -1);
  const values: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (index < body.length && isTypeWhitespace(body[index]!)) index += 1;
    if (body[index] !== "'") return undefined;
    index += 1;
    let value = "";
    let closed = false;
    while (index < body.length) {
      const char = body[index]!;
      if (char === "\\" && index + 1 < body.length) {
        value += body[index + 1]!;
        index += 2;
      } else if (char === "'" && body[index + 1] === "'") {
        value += "'";
        index += 2;
      } else if (char === "'") {
        closed = true;
        index += 1;
        break;
      } else {
        value += char;
        index += 1;
      }
    }
    if (!closed) return undefined;
    values.push(value);
    while (index < body.length && isTypeWhitespace(body[index]!)) index += 1;
    if (index === body.length) break;
    if (body[index] !== ",") return undefined;
    index += 1;
  }
  return values;
}

export function mySqlEnumValues(databaseType: string): readonly string[] | undefined {
  return mySqlCollectionValues(databaseType, "enum");
}

export function mySqlSetValues(databaseType: string): readonly string[] | undefined {
  return mySqlCollectionValues(databaseType, "set");
}

export function isKnownMySqlType(databaseType: string, schema?: SchemaSnapshot): boolean {
  const type = baseType(databaseType);
  return mySqlCatalogType(type, schema) !== undefined || schema?.domains?.[type] !== undefined;
}

export function mapMySqlType(databaseType: string, policy: MySqlTypePolicy, schema?: SchemaSnapshot): string {
  const type = baseType(databaseType);
  const values = mySqlEnumValues(databaseType);
  if (values !== undefined) return values.map((value) => JSON.stringify(value)).join(" | ") || "never";
  if (type === "enum") return policy.unknown;
  if (type === "tinyint" && /^tinyint\(1\)/iu.test(databaseType)) return policy.tinyint1;
  const mapping = mySqlCatalogType(type, schema)?.mapping;
  if (mapping === "number") return "number";
  if (mapping === "bytes") return "Uint8Array";
  if (mapping === "bigint") return policy.bigint;
  if (mapping === "numeric") return policy.decimal;
  if (mapping === "boolean") return "boolean";
  if (mapping === "string") return "string";
  if (mapping === "date") return policy.date;
  if (mapping === "json") return policy.json;
  return schema?.domains?.[type]?.tsType ?? policy.unknown;
}
