export interface SqlFuzzRegression {
  readonly id: string;
  readonly source: string;
  readonly targets: readonly ("scanner" | "parser" | "resolver")[];
  readonly reason: string;
}

/**
 * Minimized inputs retained after a parser, resolver, or span-accounting defect. Add the smallest
 * source that still reproduces a discovered failure; generated random inputs do not belong here.
 */
export const sqlFuzzRegressions: readonly SqlFuzzRegression[] = Object.freeze([
  {
    id: "nested-comment-boundary",
    source: "SELECT /* a /* b */ c */ 1",
    targets: ["scanner", "parser"],
    reason: "Nested comment termination must not corrupt following token offsets.",
  },
  {
    id: "escaped-identifier-boundary",
    source: 'SELECT "a""b", `c``d`, [e]]f]',
    targets: ["scanner", "parser"],
    reason: "Dialect identifier escapes must terminate at the correct source offset.",
  },
  {
    id: "unterminated-dollar-quote",
    source: "SELECT $body$unterminated",
    targets: ["scanner", "parser"],
    reason: "An unterminated dollar quote must produce bounded deterministic failure evidence.",
  },
  {
    id: "deep-row-expression",
    source: "SELECT (((((((((1)))))))))",
    targets: ["parser", "resolver"],
    reason: "Nested expressions must obey depth limits without recursive overflow.",
  },
  {
    id: "mixed-parameter-spelling",
    source: "SELECT $2, ?, :named, @named",
    targets: ["scanner", "parser", "resolver"],
    reason: "Parameter spellings remain grammar-owned and retain stable spans.",
  },
]);

export const FUZZ_SEEDS = Object.freeze({
  sql: 0x51_7a_2026,
  rendering: 0x72_65_6e_64,
  schema: 0x73_63_68_6d,
});

export const SQL_FUZZ_ALPHABET = "SELECT FROM WHERE WITH INSERT UPDATE DELETE RETURNING abc_123$?(),.*+-/'\\\"[]`\n\t";

export function deterministicStrings(
  seed: number,
  count: number,
  options: { readonly alphabet?: string; readonly maximumLength?: number } = {},
): readonly string[] {
  const alphabet = options.alphabet ?? SQL_FUZZ_ALPHABET;
  const maximumLength = options.maximumLength ?? 160;
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Fuzz count must be a non-negative integer");
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1)
    throw new TypeError("Fuzz maximumLength must be a positive integer");
  if (alphabet.length === 0) throw new TypeError("Fuzz alphabet cannot be empty");
  let state = seed >>> 0;
  const sources: string[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const length = state % maximumLength;
    let source = "";
    for (let offset = 0; offset < length; offset += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      source += alphabet[state % alphabet.length];
    }
    sources.push(source);
  }
  return Object.freeze(sources);
}
