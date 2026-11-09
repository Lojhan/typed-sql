import { sqliteAsciiUpper } from "../identifier-case.js";
import type { SqliteKeywordLookup } from "../vocabulary/types.js";
import type { SourceRange, Token, TokenKind } from "./types.js";

export const DEFAULT_MAX_SQL_LENGTH = 1_000_000;
export const DEFAULT_MAX_TOKENS = 100_000;

export interface TokenizeOptions {
  readonly keywordLookup?: SqliteKeywordLookup;
  /** SQL asset frontend only; ordinary SQL analysis does not enable named bindings. */
  readonly sqlFileParameters?: boolean;
  readonly maxSqlLength?: number;
  readonly maxTokens?: number;
}

// Parser terminals are distinct from the complete vendor keyword vocabulary.
const syntaxWords = new Set([
  "ABORT",
  "ALL",
  "AND",
  "ARRAY",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CAST",
  "COLLATE",
  "COALESCE",
  "CONFLICT",
  "COUNT",
  "CROSS",
  "CURRENT",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DO",
  "ELSE",
  "END",
  "EXCEPT",
  "EXCLUDE",
  "EXCLUDED",
  "EXISTS",
  "FAIL",
  "FALSE",
  "FILTER",
  "FIRST",
  "FOLLOWING",
  "FOR",
  "FROM",
  "FULL",
  "GROUP",
  "GROUPS",
  "HAVING",
  "ILIKE",
  "IGNORE",
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
  "OTHERS",
  "OUTER",
  "OVER",
  "PARTITION",
  "PRECEDING",
  "RECURSIVE",
  "RANGE",
  "REPLACE",
  "RETURNING",
  "RIGHT",
  "ROLLBACK",
  "ROW",
  "ROWS",
  "SELECT",
  "SET",
  "SHARE",
  "SIMILAR",
  "SKIP",
  "SUM",
  "THEN",
  "TIES",
  "TO",
  "TRUE",
  "UNION",
  "UNBOUNDED",
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
  readonly #keywordLookup: SqliteKeywordLookup | undefined;
  readonly #maxTokens: number;
  #index = 0;
  #line = 1;
  #column = 1;
  #parameterIndex = 0;
  readonly #sqlFileParameters: boolean;

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
    this.#keywordLookup = options.keywordLookup;
    this.#sqlFileParameters = options.sqlFileParameters === true;
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
    if (this.#keywordLookup !== undefined) {
      const lookaheadId = (token: Token | undefined): boolean =>
        token !== undefined &&
        (token.kind === "quoted-identifier" ||
          token.kind === "string" ||
          ((token.kind === "identifier" || token.kind === "keyword") && (token.nativeKeyword?.lookahead ?? true)));
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!,
          keyword = token.nativeKeyword;
        if (!keyword?.contextual) continue;
        const next = tokens[index + 1],
          previous = tokens[index - 1];
        let syntax: boolean;
        if (keyword.token === "WINDOW") syntax = lookaheadId(next) && tokens[index + 2]?.nativeKeyword?.token === "AS";
        else if (keyword.token === "OVER")
          syntax = previous?.value === ")" && (next?.value === "(" || lookaheadId(next));
        else if (keyword.token === "FILTER") syntax = previous?.value === ")" && next?.value === "(";
        else throw new SqlTokenizeError("Unsupported SQLite contextual keyword classifier", token.range, "TSQ401");
        if (!syntax) tokens[index] = { ...token, kind: "identifier", value: token.text };
      }
    }
    return tokens;
  }

  #scanToken(): Token {
    const start = this.#position();
    const char = this.#peek();

    if (this.#sqlFileParameters && char === ":" && this.#peek(-1) !== ":" && /[A-Za-z_]/u.test(this.#peek(1))) {
      this.#advance();
      while (/[A-Za-z0-9_]/u.test(this.#peek())) this.#advance();
      const text = this.#source.slice(start.index, this.#index);
      return this.#token("parameter", text, text.slice(1), start);
    }
    if (isWordStart(char)) return this.#scanWord(start);
    if (/[0-9]/.test(char)) return this.#scanNumber(start);
    if (char === "'") return this.#scanString(start);
    if (char === '"') return this.#scanQuotedIdentifier(start, '"');
    if (char === "`") return this.#scanQuotedIdentifier(start, "`");
    if (char === "[") return this.#scanBracketIdentifier(start);
    if (char === "$" && /[0-9]/.test(this.#peek(1))) return this.#scanParameter(start);
    if (char === "?") {
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
    const upper = sqliteAsciiUpper(text);
    const nativeKeyword = this.#keywordLookup?.(text);
    const terminal =
      this.#keywordLookup === undefined || nativeKeyword !== undefined || !this.#keywordLookup.isDeclared(upper);
    const kind: TokenKind = terminal && syntaxWords.has(upper) ? "keyword" : "identifier";
    const token = this.#token(kind, text, kind === "keyword" ? upper : text, start);
    return nativeKeyword === undefined ? token : { ...token, nativeKeyword };
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

  #scanString(start: Position): Token {
    this.#advance();
    let value = "";
    while (!this.#atEnd()) {
      const char = this.#advance();
      if (char === "'") {
        if (this.#peek() === "'") {
          this.#advance();
          value += "'";
          continue;
        }
        return this.#token("string", this.#source.slice(start.index, this.#index), value, start);
      }
      value += char;
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
