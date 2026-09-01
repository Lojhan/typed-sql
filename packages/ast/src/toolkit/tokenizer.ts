import {
  DEFAULT_MAX_SQL_LENGTH,
  DEFAULT_MAX_TOKENS,
  type SourceRange,
  type SqlIdentifierQuote,
  type SqlLexicalProfile,
  type SqlStringMode,
  SqlToolkitError,
  type SqlToolkitLimits,
  type Token,
  type TokenKind,
} from "./types.js";

interface Position {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function isWordStart(value: string): boolean {
  return value === "_" || /\p{L}/u.test(value);
}

function isWordPart(value: string): boolean {
  return value === "_" || value === "$" || /[\p{L}\p{N}]/u.test(value);
}

class Scanner {
  readonly #source: string;
  readonly #profile: SqlLexicalProfile;
  readonly #maxTokens: number;
  #index = 0;
  #line = 1;
  #column = 1;
  #anonymousParameter = 0;

  constructor(source: string, profile: SqlLexicalProfile, limits: SqlToolkitLimits) {
    const maxSqlLength = positiveLimit(limits.maxSqlLength ?? DEFAULT_MAX_SQL_LENGTH, "maxSqlLength");
    this.#maxTokens = positiveLimit(limits.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens");
    if (source.length > maxSqlLength) {
      throw new SqlToolkitError(
        `SQL exceeds the ${maxSqlLength} character parser limit`,
        { start: 0, end: source.length, line: 1, column: 1 },
        "TSQ002",
      );
    }
    this.#source = source;
    this.#profile = profile;
  }

  scan(): readonly Token[] {
    const tokens: Token[] = [];
    while (!this.#atEnd()) {
      this.#skipTrivia();
      if (this.#atEnd()) break;
      if (tokens.length >= this.#maxTokens) {
        throw new SqlToolkitError(
          `SQL exceeds the ${this.#maxTokens} token parser limit`,
          this.#range(this.#position()),
          "TSQ002",
        );
      }
      tokens.push(Object.freeze(this.#scanToken()));
    }
    const position = this.#position();
    tokens.push(Object.freeze(this.#token("eof", "", "", position)));
    return Object.freeze(tokens);
  }

  #scanToken(): Token {
    const start = this.#position();
    const stringMode = this.#profile.stringModes.find((mode) =>
      this.#source.startsWith(`${mode.prefix}${mode.quote}`, this.#index),
    );
    if (stringMode !== undefined) return this.#scanString(start, stringMode);
    const identifierQuote = this.#profile.identifierQuotes.find((quote) =>
      this.#source.startsWith(quote.open, this.#index),
    );
    if (identifierQuote !== undefined) return this.#scanQuotedIdentifier(start, identifierQuote);
    const char = this.#peek();
    if (isWordStart(char)) return this.#scanWord(start);
    if (/[0-9]/u.test(char)) return this.#scanNumber(start);
    const parameter = this.#scanParameter(start);
    if (parameter !== undefined) return parameter;
    const operator = this.#profile.operators.find((candidate) => this.#source.startsWith(candidate, this.#index));
    if (operator !== undefined) {
      this.#advanceBy(operator.length);
      return this.#token("operator", operator, operator, start);
    }
    const punctuation = this.#profile.punctuation ?? ["(", ")", ",", ".", ";", "[", "]"];
    if (punctuation.includes(char)) {
      this.#advance();
      return this.#token("punctuation", char, char, start);
    }
    this.#advance();
    throw new SqlToolkitError(`Unexpected character ${JSON.stringify(char)}`, this.#range(start));
  }

  #scanParameter(start: Position): Token | undefined {
    for (const mode of this.#profile.parameterModes) {
      if (mode.kind === "question" && this.#peek() === "?") {
        this.#advance();
        this.#anonymousParameter += 1;
        return this.#token("parameter", "?", String(this.#anonymousParameter), start);
      }
      const marker = mode.kind === "numbered-dollar" ? "$" : mode.kind === "numbered-question" ? "?" : undefined;
      if (marker === undefined || this.#peek() !== marker || !/[0-9]/u.test(this.#peek(1))) continue;
      this.#advance();
      while (/[0-9]/u.test(this.#peek())) this.#advance();
      const text = this.#source.slice(start.index, this.#index);
      const value = Number(text.slice(1));
      const startAt = mode.startAt ?? 1;
      if (!Number.isSafeInteger(value) || value < startAt) {
        throw new SqlToolkitError(`SQL parameters start at ${marker}${startAt}`, this.#range(start));
      }
      return this.#token("parameter", text, String(value), start);
    }
    return undefined;
  }

  #scanWord(start: Position): Token {
    while (isWordPart(this.#peek())) this.#advance();
    const text = this.#source.slice(start.index, this.#index);
    const upper = text.toUpperCase();
    const kind: TokenKind = this.#profile.keywords.has(upper) ? "keyword" : "identifier";
    return this.#token(kind, text, kind === "keyword" ? upper : text, start);
  }

  #scanNumber(start: Position): Token {
    while (/[0-9]/u.test(this.#peek())) this.#advance();
    if (this.#peek() === "." && /[0-9]/u.test(this.#peek(1))) {
      this.#advance();
      while (/[0-9]/u.test(this.#peek())) this.#advance();
    }
    if ((this.#peek() === "e" || this.#peek() === "E") && /[+\-0-9]/u.test(this.#peek(1))) {
      this.#advance();
      if (this.#peek() === "+" || this.#peek() === "-") this.#advance();
      if (!/[0-9]/u.test(this.#peek())) throw new SqlToolkitError("Invalid numeric exponent", this.#range(start));
      while (/[0-9]/u.test(this.#peek())) this.#advance();
    }
    const text = this.#source.slice(start.index, this.#index);
    return this.#token("number", text, text, start);
  }

  #scanString(start: Position, mode: SqlStringMode): Token {
    this.#advanceBy(mode.prefix.length + mode.quote.length);
    let value = "";
    while (!this.#atEnd()) {
      if (this.#source.startsWith(mode.quote, this.#index)) {
        this.#advanceBy(mode.quote.length);
        if (this.#source.startsWith(mode.quote, this.#index)) {
          this.#advanceBy(mode.quote.length);
          value += mode.quote;
          continue;
        }
        return this.#token("string", this.#source.slice(start.index, this.#index), value, start);
      }
      const char = this.#advance();
      if (mode.backslashEscapes === true && char === "\\" && !this.#atEnd()) {
        const escaped = this.#advance();
        value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
      } else value += char;
    }
    throw new SqlToolkitError("Unterminated string literal", this.#range(start));
  }

  #scanQuotedIdentifier(start: Position, quote: SqlIdentifierQuote): Token {
    this.#advanceBy(quote.open.length);
    let value = "";
    while (!this.#atEnd()) {
      if (this.#source.startsWith(quote.close, this.#index)) {
        this.#advanceBy(quote.close.length);
        if (quote.escape === "double-close" && this.#source.startsWith(quote.close, this.#index)) {
          this.#advanceBy(quote.close.length);
          value += quote.close;
          continue;
        }
        return this.#token("quoted-identifier", this.#source.slice(start.index, this.#index), value, start);
      }
      value += this.#advance();
    }
    throw new SqlToolkitError("Unterminated quoted identifier", this.#range(start));
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
        moved = true;
        const start = this.#position();
        this.#advanceBy(2);
        let depth = 1;
        while (!this.#atEnd() && depth > 0) {
          if (this.#profile.nestedBlockComments === true && this.#peek() === "/" && this.#peek(1) === "*") {
            depth += 1;
            this.#advanceBy(2);
          } else if (this.#peek() === "*" && this.#peek(1) === "/") {
            depth -= 1;
            this.#advanceBy(2);
          } else this.#advance();
        }
        if (depth > 0) throw new SqlToolkitError("Unterminated block comment", this.#range(start));
      }
    }
  }

  #advanceBy(length: number): void {
    for (let index = 0; index < length; index += 1) this.#advance();
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
    return Object.freeze({ start: start.index, end: this.#index, line: start.line, column: start.column });
  }

  #token(kind: TokenKind, text: string, value: string, start: Position): Token {
    return { kind, text, value, range: this.#range(start) };
  }
}

export function tokenizeSql(
  source: string,
  profile: SqlLexicalProfile,
  limits: SqlToolkitLimits = {},
): readonly Token[] {
  return new Scanner(source, profile, limits).scan();
}
