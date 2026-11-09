import {
  applyDialectCapabilityStates,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { resolveSqliteCapabilities } from "./capabilities.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { type SqliteProfileOptions as SqliteDialectOptions, sqliteProfile } from "./profile.js";
import { hasStableRepeatedResult } from "./repeated-inputs.js";
import { resolveSqliteStatement } from "./resolver.js";
import { analyzeSqliteSemantics } from "./semantics.js";
import type { SqliteSchemaSnapshot } from "./snapshot.js";
import type { SqliteTypePolicy } from "./type-policy.js";
import { sqliteVocabulary } from "./vocabulary/index.js";
import type { SqliteKeywordLookup } from "./vocabulary/types.js";

export function createSqliteDialect(
  options: SqliteDialectOptions = {},
  core = false,
): DialectPlugin<SqliteSchemaSnapshot, SqliteTypePolicy> {
  const profile = sqliteProfile(options);
  const defaultTypePolicy = profile.defaultTypePolicy;
  const vocabularies = new WeakMap<SqliteSchemaSnapshot, SqliteKeywordLookup>();
  return Object.freeze({
    ...profile,
    analyze(
      sql: string,
      snapshot: SqliteSchemaSnapshot,
      policy = defaultTypePolicy,
      context: DialectAnalysisContext = {},
    ) {
      try {
        let keywordLookup = vocabularies.get(snapshot);
        if (keywordLookup === undefined) {
          keywordLookup = sqliteVocabulary(snapshot.server?.versionKey ?? snapshot.version).forOptions(
            snapshot.server?.features,
          );
          vocabularies.set(snapshot, keywordLookup);
        }
        const statement = parseStatement(sql, { keywordLookup });
        const resolved = resolveSqliteStatement(statement, snapshot, {
          typePolicy: policy,
          runtimeValidation: context.runtimeValidation === true,
          unknownRoutineRequiresContract: core,
        });
        const analysis = {
          ...resolved,
          ...(hasStableRepeatedResult(sql, statement, context.repeatedFragmentRanges)
            ? { repeatedResultShapeStable: true as const }
            : {}),
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "SQLite semantic analysis reported an error.")
            : analyzeSqliteSemantics(statement, snapshot),
        };
        return applyDialectCapabilityStates(analysis, resolveSqliteCapabilities(snapshot), statement.range);
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        return {
          columns: [],
          parameters: [],
          diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }],
          semantics: unknownQuerySemantics(error.range, "The SQL could not be parsed by the SQLite grammar."),
        };
      }
    },
  });
}
