import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { assertSqliteServerEvidence, resolveSqliteCapabilities, SQLITE_CAPABILITIES } from "./capabilities.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { resolveSqliteStatement } from "./resolver.js";
import { analyzeSqliteSemantics } from "./semantics.js";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshot } from "./snapshot.js";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

export interface SqliteDialectOptions {
  readonly typePolicy?: SqliteTypePolicy;
}

export function sqlite(options: SqliteDialectOptions = {}): DialectPlugin<SqliteSchemaSnapshot, SqliteTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultSqliteTypePolicy;
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "sqlite",
    grammarVersion: SQLITE_DIALECT_VERSION,
    sqlModule: "@typed-sql/sqlite",
    capabilities: SQLITE_CAPABILITIES,
    resolveCapabilities: resolveSqliteCapabilities,
    defaultTypePolicy,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("SQLite parameter indexes start at 1");
      return "?";
    },
    quoteIdentifier(identifier: string): string {
      return `"${identifier.replaceAll('"', '""')}"`;
    },
    analyze(sql: string, snapshot: SqliteSchemaSnapshot, policy = defaultTypePolicy) {
      try {
        const statement = parseStatement(sql);
        const resolved = resolveSqliteStatement(statement, snapshot, { typePolicy: policy });
        const analysis = {
          ...resolved,
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
    validateSnapshot(value: unknown) {
      const snapshot = parseSqliteSchemaSnapshot(value);
      if (snapshot.server !== undefined && snapshot.server.product !== "sqlite") {
        throw new TypeError(`@typed-sql/sqlite cannot use ${snapshot.server.product} server evidence`);
      }
      if (snapshot.server !== undefined) assertSqliteServerEvidence(snapshot.server);
      if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== SQLITE_DIALECT_VERSION) {
        throw new TypeError(
          `@typed-sql/sqlite grammar ${SQLITE_DIALECT_VERSION} cannot use snapshot dialectVersion ${snapshot.dialectVersion}`,
        );
      }
      return snapshot;
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
