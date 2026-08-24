import type { SourceRange, Token, TokenKind } from "./types.js";

const keywords = new Set([
  "ALL", "AND", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "COALESCE",
  "COUNT", "DESC", "DISTINCT", "ELSE", "END", "FALSE", "FROM", "FULL",
  "GROUP", "HAVING", "INNER", "IS", "JOIN", "LEFT", "LIKE", "LIMIT", "MAX",
  "MIN", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER", "RIGHT",
  "SELECT", "SUM", "THEN", "TRUE", "WHEN", "WHERE",
]);

export class SqlTokenizeError extends Error {
  readonly range: SourceRange;

  constructor(message: string, range: SourceRange) {
    super(message);
    this.name = "SqlTokenizeError";
    this.range = range;
  }
}

interface Position {
  readonly index: number;
  readonly line: number;
  readonly column: number;
}

class Scanner {
  readonly #source: string;
  #index = 0;
  #line = 1;
  #column = 1;

  constructor(source: string) {
    this.#source = source;
  }

  scan(): readonly Token[] {
    const tokens: Token[] = [];
    while (!this.#atEnd()) {
      this.#skipTrivia();
      if (this.#atEnd()) break;
      tokens.push(this.#scanToken());
    }
    const position = this.#position();
    tokens.push(this.#token("eof", "", "", position));
    return tokens;
  }

  #scanToken(): Token {
    const start = this.#position();
    const char = this.#peek();

    if (/[A-Za-z_]/.test(char)) return this.#scanWord(start);
    if (/[0-9]/.test(char)) return this.#scanNumber(start);
    if (char === "'") return this.#scanString(start);
    if (char === '"') return this.#scanQuotedIdentifier(start);
    if (char === "$" && /[0-9]/.test(this.#peek(1))) return this.#scanParameter(start);

    const two = char + this.#peek(1);
    if (["::", "<=", ">=", "!=", "<>", "||"].includes(two)) {
      this.#advance();
      this.#advance();
      return this.#token("operator", two, two, start);
    }
    if (["=", "<", ">", "+", "-", "*", "/", "%"].includes(char)) {
      this.#advance();
      return this.#token("operator", char, char, start);
    }
    if (["(", ")", ",", ".", ";"].includes(char)) {
      this.#advance();
      return this.#token("punctuation", char, char, start);
    }

    this.#advance();
    throw new SqlTokenizeError(`Unexpected character ${JSON.stringify(char)}`, this.#range(start));
  }

  #scanWord(start: Position): Token {
    while (/[A-Za-z0-9_$]/.test(this.#peek())) this.#advance();
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

  #scanQuotedIdentifier(start: Position): Token {
    this.#advance();
    let value = "";
    while (!this.#atEnd()) {
      const char = this.#advance();
      if (char === '"') {
        if (this.#peek() === '"') {
          this.#advance();
          value += '"';
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
    return this.#token("parameter", text, text.slice(1), start);
  }

  #skipTrivia(): void {
    let moved = true;
    while (moved) {
      moved = false;
      while (/\s/.test(this.#peek())) {
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
        while (!this.#atEnd() && !(this.#peek() === "*" && this.#peek(1) === "/")) this.#advance();
        if (this.#atEnd()) throw new SqlTokenizeError("Unterminated block comment", this.#range(start));
        this.#advance();
        this.#advance();
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
    } else {
      this.#column += 1;
    }
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

export function tokenize(source: string): readonly Token[] {
  return new Scanner(source).scan();
}
