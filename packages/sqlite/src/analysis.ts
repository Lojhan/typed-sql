import { createSqliteDialect } from "./analysis-factory.js";
import type { SqliteProfileOptions as SqliteDialectOptions } from "./profile.js";

export type { SqliteProfileOptions as SqliteDialectOptions } from "./profile.js";
export function sqlite(options: SqliteDialectOptions = {}) {
  return createSqliteDialect(options);
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
