import type { SourceRange } from "@typed-sql/core";
import type { Token } from "./types.js";
export class DuckDBParseError extends Error {
  constructor(
    message: string,
    readonly range: SourceRange,
    readonly code = "TSQ001",
  ) {
    super(message);
    this.name = "DuckDBParseError";
  }
}
export function tokenize(source: string): readonly Token[] {
  if (source.length > 1000000)
    throw new DuckDBParseError(
      "SQL exceeds the DuckDB parser source limit",
      { start: 0, end: source.length, line: 1, column: 1 },
      "TSQ002",
    );
  const tokens: Token[] = [];
  let index = 0,
    line = 1,
    column = 1;
  const position = () => ({ start: index, end: index, line, column });
  const move = () => {
    const char = source[index++]!;
    if (char === "\n") {
      line++;
      column = 1;
    } else column++;
    return char;
  };
  const emit = (kind: Token["kind"], start: SourceRange, value: string) => {
    tokens.push({ kind, text: source.slice(start.start, index), value, range: { ...start, end: index } });
    if (tokens.length > 100000) throw new DuckDBParseError("SQL token limit", start, "TSQ002");
  };
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) {
      move();
      continue;
    }
    if (source.startsWith("--", index)) {
      while (index < source.length && source[index] !== "\n") move();
      continue;
    }
    if (source.startsWith("/*", index)) {
      const start = position();
      move();
      move();
      let depth = 1;
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) {
          depth++;
          move();
          move();
        } else if (source.startsWith("*/", index)) {
          depth--;
          move();
          move();
        } else move();
      }
      if (depth) throw new DuckDBParseError("Unterminated block comment", start);
      continue;
    }
    const start = position(),
      char = source[index]!;
    const dollar = char === "$" ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(source.slice(index))?.[0] : undefined;
    if (dollar) {
      for (let i = 0; i < dollar.length; i++) move();
      let value = "";
      while (index < source.length && !source.startsWith(dollar, index)) value += move();
      if (index === source.length) throw new DuckDBParseError("Unterminated dollar string", start);
      for (let i = 0; i < dollar.length; i++) move();
      emit("string", start, value);
      continue;
    }
    const escaped = (char === "E" || char === "e") && source[index + 1] === "'";
    if (char === "'" || char === '"' || char === "`" || escaped) {
      if (escaped) move();
      const quote = move();
      let value = "",
        closed = false;
      while (index < source.length) {
        const next = move();
        if (next === quote) {
          if (source[index] === quote) {
            value += move();
          } else {
            closed = true;
            break;
          }
        } else if (escaped && next === "\\") {
          if (index >= source.length) break;
          const esc = move();
          value += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[esc] ?? esc;
        } else value += next;
      }
      if (!closed) throw new DuckDBParseError("Unterminated quoted token", start);
      emit(quote === "'" ? "string" : "quoted", start, value);
      continue;
    }
    if (char === "?" || (char === "$" && /[\p{L}\p{N}_]/u.test(source[index + 1] ?? ""))) {
      let value = move();
      while (index < source.length && /[\p{L}\p{N}_]/u.test(source[index]!)) value += move();
      emit("parameter", start, value);
      continue;
    }
    const number = /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?/u.exec(source.slice(index))?.[0];
    if (number) {
      for (let i = 0; i < number.length; i++) move();
      emit("number", start, number.replaceAll("_", ""));
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(source.slice(index))?.[0];
    if (word) {
      for (let i = 0; i < word.length; i++) move();
      emit("word", start, word);
      continue;
    }
    const operator =
      ["->>", "::", ":=", "=>", "->", "**", "//", "||", "<=", ">=", "!=", "<>", "<<", ">>", "!~~", "~~"].find((op) =>
        source.startsWith(op, index),
      ) ?? char;
    if (!/^[+\-*/%=<>&|^~!.,;:()[\]{}?]+$/u.test(operator) || char === "\0")
      throw new DuckDBParseError(`Unsupported SQL token ${char}`, start);
    for (let i = 0; i < operator.length; i++) move();
    emit("operator", start, operator);
  }
  tokens.push({ kind: "eof", text: "", value: "", range: position() });
  return tokens;
}
