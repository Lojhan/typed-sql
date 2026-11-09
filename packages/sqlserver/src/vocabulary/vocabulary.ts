import { sqlServerKeywordUpper } from "../keyword-case.js";
import type { SqlServerKeywordDeclaration, SqlServerNameContext, SqlServerVocabulary } from "./types.js";

export function createSqlServerVocabulary(
  common: readonly SqlServerKeywordDeclaration[],
  local: readonly SqlServerKeywordDeclaration[],
  contexts: readonly SqlServerNameContext[],
): SqlServerVocabulary {
  const bits = new Map(contexts.map((name, index) => [name, 1 << index]));
  if (bits.size !== 8) throw new TypeError("Invalid SQL Server vocabulary contexts");
  const words = new Map<string, number>();
  for (const [word, mask] of [...common, ...local]) {
    if (!/^[a-z_][a-z_0-9]*$/u.test(word) || !Number.isSafeInteger(mask) || mask < 0 || mask > 255)
      throw new TypeError("Invalid SQL Server vocabulary declaration");
    words.set(sqlServerKeywordUpper(word), mask);
  }
  return Object.freeze({
    allows(word: string, context: SqlServerNameContext): boolean {
      return ((words.get(sqlServerKeywordUpper(word)) ?? 255) & bits.get(context)!) !== 0;
    },
  });
}
