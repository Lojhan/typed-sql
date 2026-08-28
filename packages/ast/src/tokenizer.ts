import type { SourceRange, Token, TokenKind } from "./types.js";

export const DEFAULT_MAX_SQL_LENGTH = 1_000_000;
export const DEFAULT_MAX_TOKENS = 100_000;

export interface TokenizeOptions {
  readonly maxSqlLength?: number;
  readonly maxTokens?: number;
  readonly syntax?: "postgres" | "mysql" | "sqlite";
}

const keywords = new Set([
  "ALL",
  "AND",
  "ARRAY",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CAST",
  "COALESCE",
  "CONFLICT",
  "COUNT",
  "CROSS",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DO",
  "ELSE",
  "END",
  "EXCEPT",
  "EXCLUDED",
  "EXISTS",
  "FALSE",
  "FILTER",
  "FIRST",
  "FOR",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "ILIKE",
  "IN",
  "INNER",
  "INSERT",
  "INTERSECT",
  "INTO",
  "IS",
  "JOIN",
  "KEY",
  "LAST",
  "LATERAL",
  "LEFT",
  "LIKE",
  "LIMIT",
  "LOCK",
  "LOCKED",
  "MAX",
  "MIN",
  "MODE",
  "NO",
  "NOT",
  "NOTHING",
  "NOWAIT",
  "NULL",
  "NULLS",
  "OFFSET",
  "OF",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "OVER",
  "PARTITION",
  "RECURSIVE",
  "RETURNING",
  "RIGHT",
  "ROW",
  "SELECT",
  "SET",
  "SHARE",
  "SIMILAR",
  "SKIP",
  "SUM",
  "THEN",
  "TO",
  "TRUE",
  "UNION",
  "UPDATE",
  "USING",
  "VALUES",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
]);

const operators = [
  "#>>",
  "->>",
  "::",
  "<=",
  ">=",
  "!=",
  "<>",
  "||",
  "->",
  "#>",
  "@>",
  "<@",
  "?|",
  "?&",
  "&&",
  "!~*",
  "!~",
  "~*",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "~",
  "?",
  "&",
  "|",
  "#",
] as const;

export class SqlTokenizeError extends Error {
  readonly range: SourceRange;
  readonly code: string;

  constructor(message: string, range: SourceRange, code = "TSQ001") {
    super(message);
    this.name = "SqlTokenizeError";
    this.range = range;
    this.code = code;
  }
}

interface Position {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

function isWordStart(value: string): boolean {
  return value === "_" || /\p{L}/u.test(value);
}

function isWordPart(value: string): boolean {
  return value === "_" || value === "$" || /[\p{L}\p{N}]/u.test(value);
}

class Scanner {
  readonly #source: string;
  readonly #maxTokens: number;
  #index = 0;
  #line = 1;
  #column = 1;
  #parameterIndex = 0;
  readonly #syntax: "postgres" | "mysql" | "sqlite";

  constructor(source: string, options: TokenizeOptions) {
    const maxSqlLength = options.maxSqlLength ?? DEFAULT_MAX_SQL_LENGTH;
    if (!Number.isSafeInteger(maxSqlLength) || maxSqlLength < 1)
      throw new TypeError("maxSqlLength must be a positive safe integer");
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isSafeInteger(this.#maxTokens) || this.#maxTokens < 1)
      throw new TypeError("maxTokens must be a positive safe integer");
    if (source.length > maxSqlLength) {
      throw new SqlTokenizeError(
        `SQL exceeds the ${maxSqlLength} character parser limit`,
        { start: 0, end: source.length, line: 1, column: 1 },
        "TSQ002",
      );
    }
    this.#source = source;
    this.#syntax = options.syntax ?? "postgres";
  }

  scan(): readonly Token[] {
    const tokens: Token[] = [];
    while (!this.#atEnd()) {
      this.#skipTrivia();
      if (this.#atEnd()) break;
      if (tokens.length >= this.#maxTokens) {
        throw new SqlTokenizeError(
          `SQL exceeds the ${this.#maxTokens} token parser limit`,
          this.#range(this.#position()),
          "TSQ002",
        );
      }
      tokens.push(this.#scanToken());
    }
    const position = this.#position();
    tokens.push(this.#token("eof", "", "", position));
    return tokens;
  }

  #scanToken(): Token {
    const start = this.#position();
    const char = this.#peek();

    if ((char === "E" || char === "e") && this.#peek(1) === "'") {
      this.#advance();
      return this.#scanString(start, true);
    }
    if (isWordStart(char)) return this.#scanWord(start);
    if (/[0-9]/.test(char)) return this.#scanNumber(start);
    if (char === "'") return this.#scanString(start, false, "'");
    if (char === '"' && this.#syntax === "mysql") return this.#scanString(start, false, '"');
    if (char === '"') return this.#scanQuotedIdentifier(start, '"');
    if (char === "`" && this.#syntax !== "postgres") return this.#scanQuotedIdentifier(start, "`");
    if (char === "[" && this.#syntax === "sqlite") return this.#scanBracketIdentifier(start);
    if (char === "$" && /[0-9]/.test(this.#peek(1))) return this.#scanParameter(start);
    if (char === "$" && this.#dollarQuoteDelimiter() !== undefined) return this.#scanDollarString(start);
    if (char === "?" && this.#syntax !== "postgres") {
      this.#advance();
      this.#parameterIndex += 1;
      return this.#token("parameter", "?", String(this.#parameterIndex), start);
    }

    const operator = operators.find((candidate) => this.#source.startsWith(candidate, this.#index));
    if (operator !== undefined) {
      for (let offset = 0; offset < operator.length; offset += 1) this.#advance();
      return this.#token("operator", operator, operator, start);
    }
    if (["(", ")", ",", ".", ";", "[", "]"].includes(char)) {
      this.#advance();
      return this.#token("punctuation", char, char, start);
    }

    this.#advance();
    throw new SqlTokenizeError(`Unexpected character ${JSON.stringify(char)}`, this.#range(start));
  }

  #scanBracketIdentifier(start: Position): Token {
    this.#advance();
    let value = "";
    while (!this.#atEnd()) {
      const char = this.#advance();
      if (char === "]")
        return this.#token("quoted-identifier", this.#source.slice(start.index, this.#index), value, start);
      value += char;
    }
    throw new SqlTokenizeError("Unterminated bracket identifier", this.#range(start));
  }

  #scanWord(start: Position): Token {
    while (isWordPart(this.#peek())) this.#advance();
    const text = this.#source.slice(start.index, this.#index);
    const upper = text.toUpperCase();
    const kind: TokenKind = keywords.has(upper) ? "keyword" : "identifier";
    return this.#token(kind, text, kind === "keyword" ? upper : text, start);
  }

  #scanNumber(start: Position): Token {
    while (/[0-9]/.test(this.#peek())) this.#advance();
    if (this.#peek() === "." && /[0-9]/.test(this.#peek(1))) {
      this.#advance();
      while (/[0-9]/.test(this.#peek())) this.#advance();
    }
    if ((this.#peek() === "e" || this.#peek() === "E") && /[+\-0-9]/.test(this.#peek(1))) {
      this.#advance();
      if (this.#peek() === "+" || this.#peek() === "-") this.#advance();
      if (!/[0-9]/.test(this.#peek())) throw new SqlTokenizeError("Invalid numeric exponent", this.#range(start));
      while (/[0-9]/.test(this.#peek())) this.#advance();
    }
    const text = this.#source.slice(start.index, this.#index);
    return this.#token("number", text, text, start);
  }

  #scanString(start: Position, escaped: boolean, quote = "'"): Token {
    this.#advance();
    let value = "";
    while (!this.#atEnd()) {
      const char = this.#advance();
      if (char === quote) {
        if (this.#peek() === quote) {
          this.#advance();
          value += quote;
          continue;
        }
        return this.#token("string", this.#source.slice(start.index, this.#index), value, start);
      }
      if (escaped && char === "\\" && !this.#atEnd()) {
        const next = this.#advance();
        value += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
      } else value += char;
    }
    throw new SqlTokenizeError("Unterminated string literal", this.#range(start));
  }

  #scanDollarString(start: Position): Token {
    const delimiter = this.#dollarQuoteDelimiter()!;
    for (let index = 0; index < delimiter.length; index += 1) this.#advance();
    const contentStart = this.#index;
    const close = this.#source.indexOf(delimiter, contentStart);
    if (close === -1) {
      while (!this.#atEnd()) this.#advance();
      throw new SqlTokenizeError("Unterminated dollar-quoted string literal", this.#range(start));
    }
    while (this.#index < close) this.#advance();
    const value = this.#source.slice(contentStart, close);
    for (let index = 0; index < delimiter.length; index += 1) this.#advance();
    return this.#token("string", this.#source.slice(start.index, this.#index), value, start);
  }

  #dollarQuoteDelimiter(): string | undefined {
    if (this.#peek() !== "$") return undefined;
    let offset = 1;
    while (/[A-Za-z0-9_]/.test(this.#peek(offset))) offset += 1;
    if (this.#peek(offset) !== "$") return undefined;
    return this.#source.slice(this.#index, this.#index + offset + 1);
  }

  #scanQuotedIdentifier(start: Position, quote: '"' | "`"): Token {
    this.#advance();
    let value = "";
    while (!this.#atEnd()) {
      const char = this.#advance();
      if (char === quote) {
        if (this.#peek() === quote) {
          this.#advance();
          value += quote;
          continue;
        }
        return this.#token("quoted-identifier", this.#source.slice(start.index, this.#index), value, start);
      }
      value += char;
    }
    throw new SqlTokenizeError("Unterminated quoted identifier", this.#range(start));
  }

  #scanParameter(start: Position): Token {
    this.#advance();
    while (/[0-9]/.test(this.#peek())) this.#advance();
    const text = this.#source.slice(start.index, this.#index);
    if (text === "$0") throw new SqlTokenizeError("PostgreSQL parameters start at $1", this.#range(start));
    return this.#token("parameter", text, text.slice(1), start);
  }

  #skipTrivia(): void {
    let moved = true;
    while (moved) {
      moved = false;
      while (/\s/u.test(this.#peek())) {
        moved = true;
        this.#advance();
      }
      if (this.#peek() === "-" && this.#peek(1) === "-") {
        moved = true;
        while (!this.#atEnd() && this.#peek() !== "\n") this.#advance();
      } else if (this.#peek() === "/" && this.#peek(1) === "*") {
        const start = this.#position();
        moved = true;
        this.#advance();
        this.#advance();
        let depth = 1;
        while (!this.#atEnd() && depth > 0) {
          if (this.#peek() === "/" && this.#peek(1) === "*") {
            depth += 1;
            this.#advance();
            this.#advance();
          } else if (this.#peek() === "*" && this.#peek(1) === "/") {
            depth -= 1;
            this.#advance();
            this.#advance();
          } else this.#advance();
        }
        if (depth > 0) throw new SqlTokenizeError("Unterminated block comment", this.#range(start));
      }
    }
  }

  #atEnd(): boolean {
    return this.#index >= this.#source.length;
  }

  #peek(offset = 0): string {
    return this.#source[this.#index + offset] ?? "\0";
  }

  #advance(): string {
    const char = this.#source[this.#index] ?? "\0";
    this.#index += 1;
    if (char === "\n") {
      this.#line += 1;
      this.#column = 1;
    } else this.#column += 1;
    return char;
  }

  #position(): Position {
    return { index: this.#index, line: this.#line, column: this.#column };
  }

  #range(start: Position): SourceRange {
    return { start: start.index, end: this.#index, line: start.line, column: start.column };
  }

  #token(kind: TokenKind, text: string, value: string, start: Position): Token {
    return { kind, text, value, range: this.#range(start) };
  }
}

export function tokenize(source: string, options: TokenizeOptions = {}): readonly Token[] {
  return new Scanner(source, options).scan();
}
