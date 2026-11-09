import { sqliteAsciiUpper } from "../identifier-case.js";
import type {
  SqliteKeyword,
  SqliteKeywordCondition,
  SqliteKeywordDeclaration,
  SqliteKeywordLookup,
  SqliteKeywordMasks,
  SqliteVocabulary,
} from "./types.js";

export function sqliteKeywordCondition(condition: SqliteKeywordCondition, options: ReadonlySet<string>): boolean {
  if (typeof condition === "boolean") return condition;
  if (typeof condition === "string") return options.has(condition);
  if (condition[0] === "not") return !sqliteKeywordCondition(condition[1], options);
  if (condition[0] === "and")
    return sqliteKeywordCondition(condition[1], options) && sqliteKeywordCondition(condition[2], options);
  return sqliteKeywordCondition(condition[1], options) || sqliteKeywordCondition(condition[2], options);
}
export function createSqliteVocabulary(
  common: readonly SqliteKeywordDeclaration[],
  local: readonly SqliteKeywordDeclaration[],
  masks: SqliteKeywordMasks,
): SqliteVocabulary {
  // Own a deep immutable snapshot even for internal factory consumers supplying mutable arrays.
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  const declarations: SqliteKeywordDeclaration[] = JSON.parse(JSON.stringify([...common, ...local]));
  declarations.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (new Set(declarations.map(([name]) => name)).size !== declarations.length)
    throw new TypeError("Duplicate SQLite keyword declaration");
  const declared = new Set(declarations.map(([name]) => name));
  const ownedMasks: SqliteKeywordMasks = JSON.parse(JSON.stringify(masks));
  freeze(declarations);
  freeze(ownedMasks);
  return Object.freeze({
    declarations,
    forOptions(options: readonly string[] = []): SqliteKeywordLookup {
      const enabled = new Set(options.map((option) => option.replace(/^SQLITE_/u, "").split("=")[0]!));
      const index = new Map<string, SqliteKeyword>();
      for (const [name, token, groups, fallback, direct, contextual, lookahead, patternOperator] of declarations) {
        if (!groups.some((group) => sqliteKeywordCondition(ownedMasks[group]!, enabled))) continue;
        const canFallback = sqliteKeywordCondition(fallback, enabled);
        const id = canFallback || contextual;
        index.set(
          name,
          Object.freeze({
            name,
            token,
            expression: id || !!(direct & 1),
            bareAlias: id || !!(direct & 2),
            bareColumnAlias: !patternOperator && (id || !!(direct & 2)),
            identifier: id || !!(direct & 4),
            contextual,
            fallback: canFallback,
            lookahead: lookahead || canFallback,
          }),
        );
      }
      return Object.freeze(
        Object.assign((word: string) => (/^[A-Za-z_]+$/u.test(word) ? index.get(sqliteAsciiUpper(word)) : undefined), {
          isDeclared: (word: string) => declared.has(sqliteAsciiUpper(word)),
        }),
      );
    },
  });
}
