import { nativeTypeAliases as aliases } from "./catalog/generated/aliases.js";

/** DuckDB native logical types, independent of any driver's classes. */
export type DuckDBType =
  | { readonly kind: "scalar"; readonly name: string; readonly precision?: number; readonly scale?: number }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "list"; readonly element: DuckDBType }
  | { readonly kind: "array"; readonly element: DuckDBType; readonly length: number }
  | { readonly kind: "struct" | "union"; readonly fields: readonly DuckDBTypeField[] }
  | { readonly kind: "tuple"; readonly elements: readonly DuckDBType[] }
  | { readonly kind: "map"; readonly key: DuckDBType; readonly value: DuckDBType };
export interface DuckDBTypeField {
  readonly name: string;
  readonly type: DuckDBType;
}
export const duckDBAsciiFold = (value: string): string => value.replace(/[A-Z]/gu, (char) => char.toLowerCase());
interface TypeToken {
  readonly value: string;
  readonly quoted: boolean;
}
class TypeReader {
  private readonly tokens: TypeToken[] = [];
  private index = 0;
  private nodes = 0;
  constructor(text: string) {
    if (!text || text.length > 65536 || text.includes("\0"))
      throw new TypeError("DuckDB native type source is empty or exceeds its limit");
    for (let i = 0; i < text.length; ) {
      if (/\s/u.test(text[i]!)) {
        i++;
        continue;
      }
      const quote = text[i]!;
      if (quote === '"' || quote === "'" || quote === "`") {
        let value = "",
          closed = false;
        i++;
        while (i < text.length) {
          const char = text[i++]!;
          if (char === quote) {
            if (text[i] === quote) {
              value += quote;
              i++;
            } else {
              closed = true;
              break;
            }
          } else value += char;
        }
        if (!closed) throw new TypeError("Unterminated DuckDB native type name");
        this.tokens.push({ value, quoted: true });
        continue;
      }
      if ("(),[]".includes(quote)) {
        this.tokens.push({ value: quote, quoted: false });
        i++;
        continue;
      }
      const word = /^[\p{L}_][\p{L}\p{N}_$]*|^\d+/u.exec(text.slice(i))?.[0];
      if (!word) throw new TypeError("Invalid DuckDB native type syntax");
      this.tokens.push({ value: word, quoted: false });
      i += word.length;
      if (this.tokens.length > 8192) throw new TypeError("DuckDB native type token limit");
    }
  }
  peek(value?: string): boolean {
    return value === undefined
      ? this.index < this.tokens.length
      : this.tokens[this.index]?.value.toUpperCase() === value;
  }
  take(): TypeToken {
    const token = this.tokens[this.index++];
    if (!token) throw new TypeError("Incomplete DuckDB native type");
    return token;
  }
  accept(value: string): boolean {
    if (!this.peek(value)) return false;
    this.index++;
    return true;
  }
  expect(value: string): void {
    if (!this.accept(value)) throw new TypeError(`Expected ${value} in DuckDB native type`);
  }
  number(): number {
    const token = this.take();
    if (token.quoted || !/^\d+$/u.test(token.value)) throw new TypeError("Expected native type dimension");
    const n = Number(token.value);
    if (!Number.isSafeInteger(n)) throw new TypeError("Native type dimension limit");
    return n;
  }
  parse(depth = 0): DuckDBType {
    if (++this.nodes > 1024 || depth > 32) throw new TypeError("DuckDB native type expansion limit");
    const first = this.take();
    let name = first.value.toUpperCase(),
      result: DuckDBType;
    if (!first.quoted && (name === "TIME" || name === "TIMESTAMP") && (this.peek("WITH") || this.peek("WITHOUT"))) {
      const withZone = this.take().value.toUpperCase() === "WITH";
      this.expect("TIME");
      this.expect("ZONE");
      name = name === "TIME" ? (withZone ? "TIMETZ" : "TIME") : withZone ? "TIMESTAMPTZ" : "TIMESTAMP";
    } else if (!first.quoted && name === "DOUBLE" && this.accept("PRECISION")) name = "DOUBLE";
    name = aliases[name] ?? name;
    if (this.accept("(")) {
      if (name === "DECIMAL") {
        let precision = 18,
          scale = 3;
        if (!this.peek(")")) {
          precision = this.number();
          scale = this.accept(",") && !this.peek(")") ? this.number() : 0;
        }
        this.expect(")");
        if (precision < 1 || precision > 38 || scale < 0 || scale > precision)
          throw new TypeError("DuckDB DECIMAL precision/scale is invalid");
        result = { kind: "scalar", name, precision, scale };
      } else if (name === "VARCHAR") {
        this.number();
        this.expect(")");
        result = { kind: "scalar", name };
      } else if (name === "MAP") {
        const key = this.parse(depth + 1);
        this.expect(",");
        const value = this.parse(depth + 1);
        this.expect(")");
        result = { kind: "map", key, value };
      } else if (name === "LIST") {
        const element = this.parse(depth + 1);
        this.expect(")");
        result = { kind: "list", element };
      } else if (name === "STRUCT" || name === "UNION") {
        const fields: DuckDBTypeField[] = [];
        const seen = new Set<string>();
        do {
          const field = this.take().value;
          if (seen.has(duckDBAsciiFold(field))) throw new TypeError("Duplicate DuckDB native type field");
          seen.add(duckDBAsciiFold(field));
          fields.push({ name: field, type: this.parse(depth + 1) });
        } while (this.accept(","));
        this.expect(")");
        if (name === "UNION" && fields.length > 255) throw new TypeError("DuckDB UNION has too many members");
        result = { kind: name === "STRUCT" ? "struct" : "union", fields };
      } else if (name === "TUPLE") {
        const elements: DuckDBType[] = [];
        do {
          elements.push(this.parse(depth + 1));
        } while (this.accept(","));
        this.expect(")");
        result = { kind: "tuple", elements };
      } else if (name === "ENUM") {
        const values: string[] = [];
        do {
          const value = this.take();
          if (!value.quoted) throw new TypeError("ENUM members must be quoted");
          if (values.includes(value.value)) throw new TypeError("Duplicate ENUM member");
          values.push(value.value);
        } while (this.accept(","));
        this.expect(")");
        result = { kind: "enum", values };
      } else throw new TypeError(`Unsupported native type constructor ${name}`);
    } else result = name === "DECIMAL" ? { kind: "scalar", name, precision: 18, scale: 3 } : { kind: "scalar", name };
    while (this.accept("[")) {
      if (this.accept("]")) result = { kind: "list", element: result };
      else {
        const length = this.number();
        this.expect("]");
        if (length < 1 || length > 100000) throw new TypeError("DuckDB ARRAY dimension must be 1–100000");
        result = { kind: "array", element: result, length };
      }
      if (++this.nodes > 1024) throw new TypeError("DuckDB native type expansion limit");
    }
    return Object.freeze(result);
  }
}
export function parseDuckDBType(text: string): DuckDBType {
  const reader = new TypeReader(text);
  const result = reader.parse();
  if (reader.peek()) throw new TypeError("Trailing DuckDB native type source");
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  // Child arrays/field records are parser-owned data, never caller-provided getters.
  for (const child of Object.values(result)) freeze(child);
  return result;
}
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export function formatDuckDBType(type: DuckDBType): string {
  switch (type.kind) {
    case "scalar":
      return type.name === "DECIMAL"
        ? `DECIMAL(${type.precision},${type.scale})`
        : type.name === "NULL"
          ? '"NULL"'
          : type.name;
    case "enum":
      return `ENUM(${type.values.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")})`;
    case "list":
      return `${formatDuckDBType(type.element)}[]`;
    case "array":
      return `${formatDuckDBType(type.element)}[${type.length}]`;
    case "map":
      return `MAP(${formatDuckDBType(type.key)}, ${formatDuckDBType(type.value)})`;
    case "tuple":
      return `TUPLE(${type.elements.map(formatDuckDBType).join(", ")})`;
    default:
      return `${type.kind.toUpperCase()}(${type.fields.map((field) => `${quote(field.name)} ${formatDuckDBType(field.type)}`).join(", ")})`;
  }
}

/** Logical children retain native shape and position without depending on SDK classes. */
export function duckDBTypeChildren(type: DuckDBType): readonly DuckDBType[] {
  switch (type.kind) {
    case "list":
    case "array":
      return [type.element];
    case "tuple":
      return type.elements;
    case "struct":
    case "union":
      return type.fields.map((field) => field.type);
    case "map":
      return [type.key, type.value];
    default:
      return [];
  }
}

export function duckDBOutputType(type: DuckDBType, version: string): DuckDBType {
  if (version !== "1.5.6") return type;
  switch (type.kind) {
    case "scalar":
      return type.name === "NULL" ? { kind: "scalar", name: "INTEGER" } : type;
    case "list":
    case "array":
      return { ...type, element: duckDBOutputType(type.element, version) };
    case "struct":
    case "union":
      return {
        ...type,
        fields: type.fields.map((field) => ({ ...field, type: duckDBOutputType(field.type, version) })),
      };
    case "tuple":
      return { ...type, elements: type.elements.map((element) => duckDBOutputType(element, version)) };
    case "map":
      return { ...type, key: duckDBOutputType(type.key, version), value: duckDBOutputType(type.value, version) };
    default:
      return type;
  }
}
