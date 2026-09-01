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

export function mySqlEnumValues(databaseType: string): readonly string[] | undefined {
  const type = databaseType.trim();
  if (type.slice(0, 5).toLowerCase() !== "enum(" || !type.endsWith(")")) return undefined;
  const body = type.slice(5, -1);
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

export function isKnownMySqlType(databaseType: string, schema?: SchemaSnapshot): boolean {
  const type = baseType(databaseType);
  return (
    [
      "tinyint",
      "smallint",
      "mediumint",
      "int",
      "integer",
      "bigint",
      "decimal",
      "numeric",
      "float",
      "double",
      "real",
      "bit",
      "boolean",
      "bool",
      "char",
      "varchar",
      "tinytext",
      "text",
      "mediumtext",
      "longtext",
      "binary",
      "varbinary",
      "tinyblob",
      "blob",
      "mediumblob",
      "longblob",
      "date",
      "datetime",
      "timestamp",
      "time",
      "year",
      "json",
      "enum",
      "set",
    ].includes(type) || schema?.domains?.[type] !== undefined
  );
}

export function mapMySqlType(databaseType: string, policy: MySqlTypePolicy, schema?: SchemaSnapshot): string {
  const type = baseType(databaseType);
  const values = mySqlEnumValues(databaseType);
  if (values !== undefined) return values.map((value) => JSON.stringify(value)).join(" | ") || "never";
  if (type === "tinyint" && /^tinyint\(1\)/iu.test(databaseType)) return policy.tinyint1;
  if (["tinyint", "smallint", "mediumint", "int", "integer", "float", "double", "real", "year"].includes(type))
    return "number";
  if (type === "bit") return "Uint8Array";
  if (type === "bigint") return policy.bigint;
  if (type === "decimal" || type === "numeric") return policy.decimal;
  if (type === "boolean" || type === "bool") return "boolean";
  if (["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "set", "time"].includes(type)) return "string";
  if (["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"].includes(type)) return "Uint8Array";
  if (["date", "datetime", "timestamp"].includes(type)) return policy.date;
  if (type === "json") return policy.json;
  return schema?.domains?.[type]?.tsType ?? policy.unknown;
}
