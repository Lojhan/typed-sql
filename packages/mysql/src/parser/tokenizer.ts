import type { SourceRange, Token, TokenKind } from "./types.js";

export const DEFAULT_MAX_SQL_LENGTH = 1_000_000;
export const DEFAULT_MAX_TOKENS = 100_000;

export interface TokenizeOptions {
  readonly maxSqlLength?: number;
  readonly maxTokens?: number;
  /** Normalized session sql_mode evidence applied before scanning. */
  readonly sqlMode?: string;
  /** @deprecated MySQL owns this parser; the syntax selector is ignored. */
  readonly syntax?: "mysql";
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
  "XOR",
]);

const operators = [
  "->>",
  "<=>",
  ":=",
  "<<",
  ">>",
  "<=",
  ">=",
  "!=",
  "<>",
  "||",
  "->",
  "&&",
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
  "!",
  "&",
  "|",
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
  readonly #ansiQuotes: boolean;
  readonly #noBackslashEscapes: boolean;
  readonly #pipesAsConcat: boolean;

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
    const modes = new Set(
      (options.sqlMode ?? "")
        .split(",")
        .map((mode) => mode.trim().toUpperCase())
        .filter(Boolean),
    );
    this.#ansiQuotes = modes.has("ANSI_QUOTES");
    this.#noBackslashEscapes = modes.has("NO_BACKSLASH_ESCAPES");
    this.#pipesAsConcat = modes.has("PIPES_AS_CONCAT");
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

    if (isWordStart(char)) return this.#scanWord(start);
    if (/[0-9]/.test(char)) return this.#scanNumber(start);
    if (char === "'") return this.#scanString(start, !this.#noBackslashEscapes, "'");
    if (char === '"' && !this.#ansiQuotes) return this.#scanString(start, !this.#noBackslashEscapes, '"');
    if (char === '"') return this.#scanQuotedIdentifier(start, '"');
    if (char === "`") return this.#scanQuotedIdentifier(start, "`");
    if (char === "?") {
      this.#advance();
      this.#parameterIndex += 1;
      return this.#token("parameter", "?", String(this.#parameterIndex), start);
    }

    const operator = operators.find((candidate) => this.#source.startsWith(candidate, this.#index));
    if (operator !== undefined) {
      for (let offset = 0; offset < operator.length; offset += 1) this.#advance();
      return this.#token(
        "operator",
        operator,
        operator === "||" && !this.#pipesAsConcat ? "OR" : operator === "&&" ? "AND" : operator,
        start,
      );
    }
    if (["(", ")", ",", ".", ";", "[", "]"].includes(char)) {
      this.#advance();
      return this.#token("punctuation", char, char, start);
    }

    this.#advance();
    throw new SqlTokenizeError(`Unexpected character ${JSON.stringify(char)}`, this.#range(start));
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
        value +=
          next === "0"
            ? "\0"
            : next === "b"
              ? "\b"
              : next === "n"
                ? "\n"
                : next === "r"
                  ? "\r"
                  : next === "t"
                    ? "\t"
                    : next === "Z"
                      ? "\u001a"
                      : next === "%" || next === "_"
                        ? `\\${next}`
                        : next;
      } else value += char;
    }
    throw new SqlTokenizeError("Unterminated string literal", this.#range(start));
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

  #skipTrivia(): void {
    let moved = true;
    while (moved) {
      moved = false;
      while (/\s/u.test(this.#peek())) {
        moved = true;
        this.#advance();
      }
      if (this.#peek() === "-" && this.#peek(1) === "-" && (this.#peek(2) === "\0" || /\s/u.test(this.#peek(2)))) {
        moved = true;
        while (!this.#atEnd() && this.#peek() !== "\n") this.#advance();
      } else if (this.#peek() === "#") {
        moved = true;
        while (!this.#atEnd() && this.#peek() !== "\n") this.#advance();
      } else if (this.#peek() === "/" && this.#peek(1) === "*") {
        const start = this.#position();
        if (this.#peek(2) === "!") {
          this.#advance();
          this.#advance();
          this.#advance();
          throw new SqlTokenizeError(
            "Executable MySQL comments require explicit structural SQL instead of implicit server-side expansion",
            this.#range(start),
            "TSQ401",
          );
        }
        moved = true;
        this.#advance();
        this.#advance();
        let closed = false;
        while (!this.#atEnd()) {
          if (this.#peek() === "*" && this.#peek(1) === "/") {
            this.#advance();
            this.#advance();
            closed = true;
            break;
          } else this.#advance();
        }
        if (!closed) throw new SqlTokenizeError("Unterminated block comment", this.#range(start));
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
