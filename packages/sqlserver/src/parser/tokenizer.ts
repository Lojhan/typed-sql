import type { SourceRange } from "@typed-sql/core";
import { SqlServerParseError, type Token } from "./types.js";
export interface TokenizeOptions {
  readonly sqlFileParameters?: boolean;
  readonly maxSqlLength?: number;
  readonly maxTokens?: number;
}
export function tokenize(source: string, options: TokenizeOptions = {}): readonly Token[] {
  const maximum = options.maxSqlLength ?? 1_000_000,
    tokenMaximum = options.maxTokens ?? 100_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(tokenMaximum) || tokenMaximum < 1)
    throw new RangeError("Tokenizer limits must be positive safe integers");
  if (source.length > maximum)
    throw new SqlServerParseError(
      "SQL source exceeds the bounded parser limit",
      { start: 0, end: source.length, line: 1, column: 1 },
      "TSQ002",
    );
  const out: Token[] = [];
  let index = 0,
    line = 1,
    column = 1,
    anonymous = 0;
  const names = new Map<string, number>();
  const position = () => ({ start: index, end: index, line, column });
  const advance = (count = 1) => {
    for (let i = 0; i < count; i++) {
      if (source[index++] === "\n") {
        line++;
        column = 1;
      } else column++;
    }
  };
  const range = (start: SourceRange): SourceRange => ({ ...start, end: index });
  const fail = (message: string, start: SourceRange): never => {
    throw new SqlServerParseError(message, range(start));
  };
  const emit = (kind: Token["kind"], value: string, start: SourceRange) => {
    out.push(
      Object.freeze({ kind, text: source.slice(start.start, index), value, range: Object.freeze(range(start)) }),
    );
  };
  const point = () => String.fromCodePoint(source.codePointAt(index) ?? 0);
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) {
      advance();
      continue;
    }
    const start = position();
    if (source.startsWith("--", index)) {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (source.startsWith("/*", index)) {
      advance(2);
      let depth = 1;
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) {
          if (++depth > 256) fail("Block comment nesting exceeds limit", start);
          advance(2);
        } else if (source.startsWith("*/", index)) {
          depth--;
          advance(2);
        } else advance();
      }
      if (depth) fail("Unterminated block comment", start);
      continue;
    }
    if (out.length >= tokenMaximum)
      throw new SqlServerParseError("SQL token count exceeds the bounded parser limit", start, "TSQ002");
    const char = source[index]!;
    if (char === "'" || ((char === "N" || char === "n") && source[index + 1] === "'")) {
      if (char !== "'") advance();
      advance();
      let value = "",
        closed = false;
      while (index < source.length) {
        if (source[index] === "'") {
          advance();
          if (source[index] === "'") {
            value += "'";
            advance();
          } else {
            closed = true;
            break;
          }
        } else {
          value += source[index];
          advance();
        }
      }
      if (!closed) fail("Unterminated string literal", start);
      emit("string", value, start);
      continue;
    }
    if (char === "[" || char === '"') {
      const close = char === "[" ? "]" : '"';
      advance();
      let value = "",
        closed = false;
      while (index < source.length) {
        if (source[index] === close) {
          advance();
          if (source[index] === close) {
            value += close;
            advance();
          } else {
            closed = true;
            break;
          }
        } else {
          value += source[index];
          advance();
        }
      }
      if (!closed) fail("Unterminated quoted identifier", start);
      if (!value) fail("Empty quoted identifier", start);
      emit("identifier", value, start);
      continue;
    }
    if (char === "@" || char === "?") {
      if (char === "?") {
        advance();
        emit("parameter", String(++anonymous), start);
        continue;
      }
      advance();
      if (char === "@" && source[index] === "@") {
        advance();
        const begin = index;
        while (index < source.length && /[\p{L}\p{N}_$]/u.test(point())) advance(point().length);
        if (index === begin) fail("Expected system variable name", start);
        emit("system", source.slice(begin, index).toUpperCase(), start);
        continue;
      }
      const begin = index;
      if (!/[\p{L}_]/u.test(point())) fail("Expected parameter identifier", start);
      while (index < source.length && /[\p{L}\p{N}_$]/u.test(point())) advance(point().length);
      const name = source.slice(begin, index);
      const generated = /^__typed_sql_(\d+)$/u.exec(name);
      if (generated) {
        const slot = Number(generated[1]);
        if (!Number.isSafeInteger(slot) || slot < 1 || slot > 2100)
          fail("SQL Server parameter index must be between 1 and 2100", start);
        emit("parameter", String(slot), start);
      } else {
        const slot = names.get(name) ?? names.size + 1;
        names.set(name, slot);
        emit("parameter", String(slot), start);
      }
      continue;
    }
    if (char === "0" && /[xX]/u.test(source[index + 1] ?? "")) {
      advance(2);
      const begin = index;
      while (index < source.length && /[0-9a-f]/iu.test(source[index]!)) advance();
      if (/[\p{L}\p{N}_]/u.test(point())) fail("Invalid binary literal", start);
      emit("binary", source.slice(begin, index), start);
      continue;
    }
    if (/[0-9]/u.test(char) || (char === "." && /[0-9]/u.test(source[index + 1] ?? ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(source.slice(index))!;
      advance(match[0].length);
      if (/[\p{L}_]/u.test(point())) fail("Invalid numeric literal", start);
      emit("number", match[0], start);
      continue;
    }
    if (/[\p{L}_#]/u.test(point())) {
      const begin = index;
      advance(point().length);
      while (index < source.length && /[\p{L}\p{N}_$#]/u.test(point())) advance(point().length);
      emit("word", source.slice(begin, index), start);
      continue;
    }
    const operator = [
      "!=",
      "<>",
      "<=",
      ">=",
      "!<",
      "!>",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "&=",
      "^=",
      "|=",
      "::",
      "+",
      "-",
      "*",
      "/",
      "%",
      "=",
      "<",
      ">",
      "&",
      "|",
      "^",
      "~",
    ].find((item) => source.startsWith(item, index));
    if (operator) {
      advance(operator.length);
      emit("operator", operator, start);
      continue;
    }
    if ("(),.;:".includes(char)) {
      advance();
      emit("punctuation", char, start);
      continue;
    }
    advance();
    fail(`Unsupported SQL character ${JSON.stringify(char)}`, start);
  }
  const end = position();
  out.push(Object.freeze({ kind: "eof", text: "", value: "", range: Object.freeze(end) }));
  return Object.freeze(out);
}
