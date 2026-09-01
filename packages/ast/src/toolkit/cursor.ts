import {
  DEFAULT_MAX_PARSE_DEPTH,
  type SourceRange,
  SqlToolkitError,
  type SqlToolkitLimits,
  type Token,
  type TokenKind,
} from "./types.js";

export class TokenCursor {
  readonly #tokens: readonly Token[];
  readonly #maxDepth: number;
  #index = 0;
  #depth = 0;

  constructor(tokens: readonly Token[], limits: SqlToolkitLimits = {}) {
    if (tokens.at(-1)?.kind !== "eof") throw new TypeError("TokenCursor requires a terminal eof token");
    this.#tokens = tokens;
    this.#maxDepth = limits.maxDepth ?? DEFAULT_MAX_PARSE_DEPTH;
    if (!Number.isSafeInteger(this.#maxDepth) || this.#maxDepth < 1)
      throw new TypeError("maxDepth must be a positive safe integer");
  }

  current(): Token {
    return this.#tokens[this.#index] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  peek(offset = 1): Token {
    return this.#tokens[this.#index + offset] ?? this.#tokens[this.#tokens.length - 1]!;
  }

  previous(): Token {
    return this.#tokens[Math.max(0, this.#index - 1)]!;
  }

  advance(): Token {
    const token = this.current();
    if (token.kind !== "eof") this.#index += 1;
    return token;
  }

  match(value: string): boolean {
    if (this.current().value !== value) return false;
    this.advance();
    return true;
  }

  matchKind(kind: TokenKind): Token | undefined {
    if (this.current().kind !== kind) return undefined;
    return this.advance();
  }

  expect(value: string): Token {
    const token = this.current();
    if (!this.match(value)) this.error(`Expected ${value}, found ${token.text || "end of query"}`, token.range);
    return token;
  }

  expectKind(kind: TokenKind, label: string = kind): Token {
    const token = this.current();
    if (token.kind !== kind) this.error(`Expected ${label}, found ${token.text || "end of query"}`, token.range);
    return this.advance();
  }

  identifier(allowKeyword = false): Token {
    const token = this.current();
    if (
      token.kind !== "identifier" &&
      token.kind !== "quoted-identifier" &&
      !(allowKeyword && token.kind === "keyword")
    ) {
      this.error(`Expected identifier, found ${token.text || "end of query"}`, token.range);
    }
    return this.advance();
  }

  delimited<T>(open: string, close: string, separator: string, parse: () => T): readonly T[] {
    this.expect(open);
    const values: T[] = [];
    if (!this.match(close)) {
      do values.push(parse());
      while (this.match(separator));
      this.expect(close);
    }
    return Object.freeze(values);
  }

  nested<T>(parse: () => T): T {
    this.#depth += 1;
    if (this.#depth > this.#maxDepth) {
      this.#depth -= 1;
      this.error(`SQL exceeds the ${this.#maxDepth} level parser nesting limit`, this.current().range, "TSQ002");
    }
    try {
      return parse();
    } finally {
      this.#depth -= 1;
    }
  }

  error(message: string, range: SourceRange = this.current().range, code = "TSQ001"): never {
    throw new SqlToolkitError(message, range, code);
  }
}

class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: Iterable<readonly [Key, Value]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: Key): Value | undefined {
    return this.#values.get(key);
  }

  has(key: Key): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[Key, Value]> {
    return this.#values.entries();
  }

  keys(): MapIterator<Key> {
    return this.#values.keys();
  }

  values(): MapIterator<Value> {
    return this.#values.values();
  }

  forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callback.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

export function definePrecedenceTable(entries: Readonly<Record<string, number>>): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (const [operator, precedence] of Object.entries(entries)) {
    if (operator.length === 0 || !Number.isSafeInteger(precedence) || precedence < 0)
      throw new TypeError("Precedence entries require a non-empty operator and non-negative safe integer");
    table.set(operator, precedence);
  }
  return new ImmutableMap(table);
}

export function walkTree<Node>(
  root: Node,
  children: (node: Node) => readonly Node[],
  visit: (node: Node, parent: Node | undefined) => void,
): void {
  const active = new Set<Node>();
  const walk = (node: Node, parent: Node | undefined): void => {
    if (active.has(node)) throw new TypeError("SQL tree walkers cannot traverse cyclic nodes");
    active.add(node);
    visit(node, parent);
    for (const child of children(node)) walk(child, node);
    active.delete(node);
  };
  walk(root, undefined);
}
