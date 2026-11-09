import { duckDBAsciiFold } from "../native-types.js";
import type { DuckDBKeyword, DuckDBKeywordDeclaration, DuckDBVocabulary } from "./types.js";

/** The private lookup owns copied records; grammar classes are independent permissions. */
export function createDuckDBVocabulary(
  common: readonly DuckDBKeywordDeclaration[],
  local: readonly DuckDBKeywordDeclaration[],
  bareLabels: readonly string[],
  specialFunctionHeads: readonly string[],
  functionClasses: string,
): DuckDBVocabulary {
  const bare = new Set(bareLabels),
    heads = new Set(specialFunctionHeads);
  const words = new Map<string, DuckDBKeyword>();
  for (const [name, classes] of [...common, ...local]) {
    if (!/^[a-z][a-z_0-9]*$/u.test(name) || !/^[RUCFT]+$/u.test(classes) || words.has(name))
      throw new TypeError("Invalid DuckDB vocabulary declaration");
    words.set(
      name,
      Object.freeze({
        name,
        classes,
        identifier: /[UC]/u.test(classes),
        functionName: [...classes].some((value) => functionClasses.includes(value)) || heads.has(name),
        typeName: /[UT]/u.test(classes),
        bareLabel: bare.has(name),
      }),
    );
  }
  return Object.freeze({ lookup: (word: string) => words.get(duckDBAsciiFold(word)) });
}
