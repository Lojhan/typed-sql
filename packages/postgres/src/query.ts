import type { RuntimeValueType, SqlRenderer } from "@typed-sql/core";
import { defaultPostgresTypePolicy, mapPostgresType, type PostgresTypePolicy } from "./type-policy.js";

export { sql } from "@typed-sql/core";

export const postgresRenderer: SqlRenderer = Object.freeze({
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
});

/** PostgreSQL owns its physical wire syntax; neutral runtime decoders receive normalized values. */
export function normalizePostgresValue(value: unknown, type: RuntimeValueType): unknown {
  if (typeof type === "object" && "literal" in type)
    return normalizePostgresValue(value, typeof type.literal as "string" | "number" | "boolean");
  if (typeof value === "string" && type === "bigint") {
    if (!/^[+-]?\d+$/u.test(value)) throw new TypeError("Invalid PostgreSQL integer text");
    return BigInt(value);
  }
  if (typeof value === "string" && type === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value))
      throw new TypeError("Invalid PostgreSQL number text");
    const number = Number(value);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
      throw new RangeError("PostgreSQL numeric value exceeds the requested number precision");
    return number;
  }
  if (typeof value === "string" && type === "date") return new Date(value);
  if (type === "boolean" && typeof value === "string") {
    if (value === "t") return true;
    if (value === "f") return false;
  }
  if (type === "bytes" && typeof value === "string") {
    if (!/^\\x(?:[a-f\d]{2})*$/iu.test(value)) throw new TypeError("Invalid PostgreSQL bytea hex value");
    return Uint8Array.from(value.slice(2).match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
  }
  if (typeof type === "object" && "array" in type) {
    const values = typeof value === "string" ? parsePostgresArray(value) : value;
    if (Array.isArray(values))
      return values.map((item) => (item === null ? null : normalizePostgresValue(item, type.array)));
  }
  return value;
}

function parsePostgresArray(source: string): unknown[] {
  if (source.length > 8 * 1024 * 1024) throw new RangeError("PostgreSQL array exceeds the wire size limit");
  let index = 0;
  let items = 0;
  const dimensions = /^(?:\[-?\d+:-?\d+\])+=/u.exec(source);
  if (dimensions !== null) index = dimensions[0].length;
  const level = (depth: number): unknown[] => {
    if (depth > 64 || source[index++] !== "{") throw new TypeError("Invalid PostgreSQL array nesting");
    const result: unknown[] = [];
    if (source[index] === "}") {
      index += 1;
      return result;
    }
    while (index < source.length) {
      if (++items > 100_000) throw new RangeError("PostgreSQL array exceeds the item limit");
      if (source[index] === "{") result.push(level(depth + 1));
      else {
        const quoted = source[index] === '"';
        if (quoted) index += 1;
        let text = "";
        let closed = !quoted;
        while (index < source.length) {
          const char = source[index++]!;
          if (char === "\\") {
            if (index >= source.length) throw new TypeError("Truncated PostgreSQL array escape");
            text += source[index++];
          } else if (quoted && char === '"') {
            closed = true;
            break;
          } else if (!quoted && (char === "," || char === "}")) {
            index -= 1;
            break;
          } else text += char;
        }
        if (!closed || (!quoted && text.length === 0)) throw new TypeError("Invalid PostgreSQL array element");
        result.push(!quoted && text === "NULL" ? null : text);
      }
      if (source[index] === "}") {
        index += 1;
        return result;
      }
      if (source[index++] !== ",") throw new TypeError("Invalid PostgreSQL array delimiter");
    }
    throw new TypeError("Unterminated PostgreSQL array");
  };
  const result = level(0);
  if (index !== source.length) throw new TypeError("Trailing PostgreSQL array data");
  return result;
}

export function postgresRuntimeValueType(
  value: { readonly databaseType?: string; readonly tsType: string; readonly nullable: boolean },
  policy: PostgresTypePolicy = defaultPostgresTypePolicy,
): RuntimeValueType {
  const databaseType = value.databaseType?.trim();
  if (databaseType?.endsWith("[]")) {
    const base = databaseType.slice(0, -2);
    return {
      array: postgresRuntimeValueType({ ...value, databaseType: base, tsType: mapPostgresType(base, policy) }, policy),
    };
  }
  switch (value.tsType) {
    case "number":
    case "bigint":
    case "boolean":
    case "string":
      return value.tsType;
    case "Date":
      return "date";
    case "Uint8Array":
      return "bytes";
    default:
      return "unknown";
  }
}
