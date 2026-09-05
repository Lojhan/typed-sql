interface TokenPosition {
  readonly line: number;
  readonly character: number;
  readonly length: number;
}

/** Decode virtual relative positions and re-encode only source-visible tokens. */
export function projectSemanticTokens(
  data: unknown,
  project: (token: TokenPosition) => TokenPosition | undefined,
): number[] {
  if (!Array.isArray(data) || data.length % 5 !== 0 || data.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new TypeError("Invalid upstream semantic token data");
  }
  const result: number[] = [];
  let line = 0;
  let character = 0;
  let previousLine = 0;
  let previousCharacter = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    const token = project({ line, character, length: data[index + 2] });
    if (token === undefined || token.length === 0) continue;
    const deltaLine = token.line - previousLine;
    const deltaCharacter = deltaLine === 0 ? token.character - previousCharacter : token.character;
    if (deltaLine < 0 || deltaCharacter < 0 || token.length < 0) {
      throw new TypeError("Semantic token projection is not source ordered");
    }
    result.push(deltaLine, deltaCharacter, token.length, data[index + 3], data[index + 4]);
    previousLine = token.line;
    previousCharacter = token.character;
  }
  return result;
}

interface TokenSnapshot {
  readonly resultId: string;
  readonly data: readonly number[];
}

/** Client result IDs identify projected data, never upstream virtual arrays. */
export class SemanticTokenResults {
  readonly #entries = new Map<string, TokenSnapshot>();
  #integers = 0;
  #sequence = 0;

  constructor(
    readonly maxEntries = 256,
    readonly maxIntegers = 262_144,
  ) {}

  delete(uri: string): void {
    this.#integers -= this.#entries.get(uri)?.data.length ?? 0;
    this.#entries.delete(uri);
  }

  response(uri: string, data: readonly number[], previousResultId?: string): unknown {
    const previous = this.#entries.get(uri);
    this.delete(uri);
    // Oversized responses remain correct without retaining unbounded history.
    if (data.length > this.maxIntegers) return { data };
    while (this.#entries.size >= this.maxEntries || this.#integers + data.length > this.maxIntegers) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    const resultId = `typed-sql:${++this.#sequence}`;
    this.#entries.set(uri, { resultId, data: [...data] });
    this.#integers += data.length;
    if (previous === undefined || previous.resultId !== previousResultId) return { resultId, data };
    let start = 0;
    while (start < previous.data.length && start < data.length && previous.data[start] === data[start]) start++;
    let beforeEnd = previous.data.length;
    let afterEnd = data.length;
    while (beforeEnd > start && afterEnd > start && previous.data[beforeEnd - 1] === data[afterEnd - 1]) {
      beforeEnd--;
      afterEnd--;
    }
    return {
      resultId,
      edits:
        beforeEnd === start && afterEnd === start
          ? []
          : [{ start, deleteCount: beforeEnd - start, data: data.slice(start, afterEnd) }],
    };
  }
}
