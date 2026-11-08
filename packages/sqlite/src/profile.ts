import { DIALECT_CONTRACT_VERSION, type DialectProfile } from "@typed-sql/core";
import { assertSqliteServerEvidence, resolveSqliteCapabilities, SQLITE_CAPABILITIES } from "./capabilities.js";
import { tokenize } from "./parser/tokenizer.js";
import { sqliteRuntimeValueType } from "./query.js";
import { parseSqliteSchemaSnapshot, type SqliteSchemaSnapshot } from "./snapshot.js";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

export interface SqliteProfileOptions {
  readonly typePolicy?: SqliteTypePolicy;
}

export function sqliteProfile(
  options: SqliteProfileOptions = {},
): DialectProfile<SqliteSchemaSnapshot, SqliteTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultSqliteTypePolicy;
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "sqlite",
    grammarVersion: SQLITE_DIALECT_VERSION,
    sqlModule: "@typed-sql/sqlite",
    runtimeSqlModule: "@typed-sql/sqlite/query",
    capabilities: SQLITE_CAPABILITIES,
    resolveCapabilities: resolveSqliteCapabilities,
    defaultTypePolicy,
    runtimeValueType: sqliteRuntimeValueType,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("SQLite parameter indexes start at 1");
      return "?";
    },
    quoteIdentifier(identifier: string): string {
      return `"${identifier.replaceAll('"', '""')}"`;
    },
    parameterOccurrences(sql: string) {
      return tokenize(sql, { sqlFileParameters: true })
        .filter((token) => token.kind === "parameter")
        .map((token) => ({
          index: token.text.startsWith(":") ? 0 : Number(token.value),
          ...(token.text.startsWith(":") ? { name: token.value } : {}),
          range: token.range,
        }));
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

export type { SqliteSchemaSnapshot } from "./snapshot.js";
export type { SqliteTypePolicy } from "./type-policy.js";
export { defaultSqliteTypePolicy as typePolicy } from "./type-policy.js";
