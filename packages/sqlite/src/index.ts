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

export type { SqliteProfileOptions as SqliteDialectOptions } from "./profile.js";
export function sqlite(options: SqliteDialectOptions = {}): DialectPlugin<SqliteSchemaSnapshot, SqliteTypePolicy> {
  const profile = sqliteProfile(options);
  const defaultTypePolicy = profile.defaultTypePolicy;
  return Object.freeze({
    ...profile,
    analyze(
      sql: string,
      snapshot: SqliteSchemaSnapshot,
      policy = defaultTypePolicy,
      context: DialectAnalysisContext = {},
    ) {
      try {
        const statement = parseStatement(sql);
        const resolved = resolveSqliteStatement(statement, snapshot, {
          typePolicy: policy,
          runtimeValidation: context.runtimeValidation === true,
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

export { sql } from "@typed-sql/core";
export type { FunctionSnapshot, SchemaSnapshot } from "@typed-sql/schema";
export { resolveSqliteCapabilities, sqliteServerEvidence } from "./capabilities.js";
export type {
  SqliteQueryable,
  SqliteRoutineArgumentDeclaration,
  SqliteRoutineDeclaration,
  SqliteRoutineResultDeclaration,
  SqliteSchemaProviderOptions,
} from "./provider.js";
export { introspectSqlite, SqliteSchemaProvider } from "./provider.js";
export type {
  SqliteColumnSnapshot,
  SqliteForeignKeySnapshot,
  SqliteIndexColumnSnapshot,
  SqliteIndexSnapshot,
  SqliteSchemaSnapshot,
  SqliteSchemaSnapshotV1,
  SqliteSchemaSnapshotV2,
  SqliteTableSnapshot,
} from "./snapshot.js";
export { parseSqliteSchemaSnapshot } from "./snapshot.js";
export type { SqliteVersion, SqliteVersionSupport } from "./support.js";
export {
  compareSqliteVersions,
  isNodeSqliteRuntimeSupported,
  NODE_SQLITE_RUNTIME_SUPPORT,
  parseSqliteVersion,
  SQLITE_LANGUAGE_SUPPORT,
  sqliteVersionSupport,
} from "./support.js";
export type { SqliteAffinity, SqliteTypePolicy } from "./type-policy.js";
export {
  defaultSqliteTypePolicy,
  defaultSqliteTypePolicy as typePolicy,
  isKnownSqliteType,
  isKnownStrictSqliteType,
  mapSqliteCastType,
  mapSqliteType,
  sqliteAffinity,
  sqliteFlexibleType,
} from "./type-policy.js";
export { SQLITE_DIALECT_VERSION } from "./version.js";
