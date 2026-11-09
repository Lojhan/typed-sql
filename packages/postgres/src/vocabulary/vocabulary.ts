import type { PostgresKeyword, PostgresKeywordDeclaration, PostgresVocabulary } from "./types.js";

/** A version-owned immutable snapshot; no driver, source fetch or mutable global registration. */
export function createPostgresVocabulary(
  common: readonly PostgresKeywordDeclaration[],
  local: readonly PostgresKeywordDeclaration[],
): PostgresVocabulary {
  const words = [...common, ...local]
    .map(([name, category, bareLabel, token]) => Object.freeze({ name, category, bareLabel, token }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const index = new Map<string, PostgresKeyword>();
  for (const word of words) {
    if (index.has(word.name)) throw new TypeError("Duplicate PostgreSQL keyword declaration");
    index.set(word.name, word);
  }
  return Object.freeze({
    words: Object.freeze(words),
    lookup(word: string): PostgresKeyword | undefined {
      // PostgreSQL keywords use ASCII comparison; Unicode lookalikes remain identifiers.
      return /^[A-Za-z_]+$/u.test(word) ? index.get(word.toLowerCase()) : undefined;
    },
  });
}
