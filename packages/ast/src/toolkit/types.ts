export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export type TokenKind =
  | "identifier"
  | "quoted-identifier"
  | "keyword"
  | "number"
  | "string"
  | "parameter"
  | "operator"
  | "punctuation"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly value: string;
  readonly range: SourceRange;
}

export interface SqlIdentifierQuote {
  readonly open: string;
  readonly close: string;
  readonly escape: "double-close" | "none";
}

export interface SqlStringMode {
  readonly prefix: string;
  readonly quote: string;
  readonly backslashEscapes?: boolean;
}

export interface SqlParameterMode {
  readonly kind: "question" | "numbered-question" | "numbered-dollar";
  readonly startAt?: number;
}

export interface SqlLexicalProfile {
  readonly keywords: ReadonlySet<string>;
  readonly operators: readonly string[];
  readonly identifierQuotes: readonly SqlIdentifierQuote[];
  readonly stringModes: readonly SqlStringMode[];
  readonly parameterModes: readonly SqlParameterMode[];
  readonly punctuation?: readonly string[];
  readonly nestedBlockComments?: boolean;
}

export interface SqlToolkitLimits {
  readonly maxSqlLength?: number;
  readonly maxTokens?: number;
  readonly maxDepth?: number;
}

export const DEFAULT_MAX_SQL_LENGTH = 1_000_000;
export const DEFAULT_MAX_TOKENS = 100_000;
export const DEFAULT_MAX_PARSE_DEPTH = 128;
export const SQL_PARSER_TOOLKIT_VERSION = 1 as const;

export class SqlToolkitError extends Error {
  readonly code: string;
  readonly range: SourceRange;

  constructor(message: string, range: SourceRange, code = "TSQ001") {
    super(message);
    this.name = "SqlToolkitError";
    this.code = code;
    this.range = range;
  }
}

class ImmutableSet<Value> implements ReadonlySet<Value> {
  readonly #values: Set<Value>;

  constructor(values: Iterable<Value>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: Value): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[Value, Value]> {
    return this.#values.entries();
  }

  keys(): SetIterator<Value> {
    return this.#values.keys();
  }

  values(): SetIterator<Value> {
    return this.#values.values();
  }

  forEach(callback: (value: Value, key: Value, set: ReadonlySet<Value>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callback.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<Value> {
    return this.values();
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }
}

export function mergeSourceRanges(first: SourceRange, last: SourceRange): SourceRange {
  return Object.freeze({ start: first.start, end: last.end, line: first.line, column: first.column });
}

export function defineSqlLexicalProfile(profile: SqlLexicalProfile): SqlLexicalProfile {
  const keywords = new Set<string>();
  for (const keyword of profile.keywords) {
    if (keyword.length === 0 || keyword !== keyword.toUpperCase()) {
      throw new TypeError("SQL lexical profile keywords must be non-empty uppercase strings");
    }
    keywords.add(keyword);
  }
  const operators = [...profile.operators];
  if (operators.some((operator) => operator.length === 0))
    throw new TypeError("SQL lexical profile operators must be non-empty strings");
  operators.sort((left, right) => right.length - left.length || left.localeCompare(right));
  return Object.freeze({
    ...profile,
    keywords: new ImmutableSet(keywords),
    operators: Object.freeze(operators),
    identifierQuotes: Object.freeze(profile.identifierQuotes.map((quote) => Object.freeze({ ...quote }))),
    stringModes: Object.freeze(profile.stringModes.map((mode) => Object.freeze({ ...mode }))),
    parameterModes: Object.freeze(profile.parameterModes.map((mode) => Object.freeze({ ...mode }))),
    punctuation: Object.freeze([...(profile.punctuation ?? ["(", ")", ",", ".", ";", "[", "]"])]),
  });
}
