import {
  applyDialectCapabilityStates,
  type DialectAnalysis,
  type DialectPlugin,
  type DialectServerEvidence,
  type SchemaSnapshot,
  type SourceRange,
  unknownQuerySemantics,
} from "@typed-sql/core";
import {
  duckDBAsciiFold,
  duckDBServerEvidence,
  duckdb,
  formatDuckDBType,
} from "../../../../packages/duckdb/src/analysis.js";
import { mapDuckDBType } from "../../../../packages/duckdb/src/index.js";
import { mySqlServerEvidence, resolveMySqlCapabilities } from "../../../../packages/mysql/src/capabilities.js";
import { resolveMySqlStatement } from "../../../../packages/mysql/src/compatibility-resolver.js";
import type { MySqlSchemaSnapshot } from "../../../../packages/mysql/src/index.js";
import {
  SqlParseError as MySqlParseError,
  parseStatement as parseMySqlStatement,
} from "../../../../packages/mysql/src/parser/index.js";
import { tokenize as tokenizeMySql } from "../../../../packages/mysql/src/parser/tokenizer.js";
import { analyzeMySqlSemantics } from "../../../../packages/mysql/src/semantics.js";
import { defaultMySqlTypePolicy, mapMySqlType } from "../../../../packages/mysql/src/type-policy.js";
import { MYSQL_DIALECT_VERSION } from "../../../../packages/mysql/src/version.js";
import { postgresServerEvidence, resolvePostgresCapabilities } from "../../../../packages/postgres/src/capabilities.js";
import { resolveStatement as resolvePostgresStatement } from "../../../../packages/postgres/src/compatibility-resolver.js";
import type { PostgresSchemaSnapshot } from "../../../../packages/postgres/src/index.js";
import {
  SqlParseError as PostgresParseError,
  parseStatement as parsePostgresStatement,
} from "../../../../packages/postgres/src/parser/index.js";
import { tokenize as tokenizePostgres } from "../../../../packages/postgres/src/parser/tokenizer.js";
import { analyzePostgresSemantics } from "../../../../packages/postgres/src/semantics.js";
import { defaultPostgresTypePolicy, mapPostgresType } from "../../../../packages/postgres/src/type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "../../../../packages/postgres/src/version.js";
import type { SchemaSnapshotV2 } from "../../../../packages/schema/src/model.js";
import { resolveSqliteCapabilities, sqliteServerEvidence } from "../../../../packages/sqlite/src/capabilities.js";
import {
  parseStatement as parseSqliteStatement,
  SqlParseError as SqliteParseError,
} from "../../../../packages/sqlite/src/parser/index.js";
import { tokenize as tokenizeSqlite } from "../../../../packages/sqlite/src/parser/tokenizer.js";
import { resolveSqliteStatement } from "../../../../packages/sqlite/src/resolver.js";
import { analyzeSqliteSemantics } from "../../../../packages/sqlite/src/semantics.js";
import type { SqliteSchemaSnapshot } from "../../../../packages/sqlite/src/snapshot.js";
import { defaultSqliteTypePolicy, mapSqliteType } from "../../../../packages/sqlite/src/type-policy.js";
import { SQLITE_DIALECT_VERSION } from "../../../../packages/sqlite/src/version.js";
import {
  mapSqlServerType,
  type SqlServerServerSettings,
  sqlServerServerEvidence,
  sqlserver,
} from "../../../../packages/sqlserver/src/browser.js";

import { DEFAULT_NATIVE_ENVIRONMENTS } from "./environment-model.js";

export type PlaygroundDialect = "postgres" | "mysql" | "sqlite" | "sqlserver" | "duckdb";
export interface PlaygroundEnvironment {
  readonly version?: string;
  readonly settings?: Readonly<Record<string, string | boolean | number>>;
}

export interface BrowserDialectRuntime {
  readonly dialectVersion: string;
  readonly defaultNamespace: string;
  readonly server: (environment?: PlaygroundEnvironment) => DialectServerEvidence;
  readonly fold: (name: string, snapshot?: BrowserSchemaSnapshot) => string;
  readonly normalizeType?: (databaseType: string, snapshot: BrowserSchemaSnapshot) => string;
  readonly module: `@typed-sql/${PlaygroundDialect}`;
  readonly placeholder: (index: number) => string;
  readonly parameterOccurrences: (
    sql: string,
    snapshot: BrowserSchemaSnapshot,
  ) => readonly { readonly index: number; readonly name?: string; readonly range: SourceRange }[];
  readonly analyze: (sql: string, snapshot: BrowserSchemaSnapshot) => DialectAnalysis;
  readonly mapType: (databaseType: string, snapshot: BrowserSchemaSnapshot, strict: boolean) => string;
}

type BrowserSchemaSnapshot = SchemaSnapshotV2;

function parseFailure(
  error: unknown,
  ParseError: abstract new (...args: never[]) => Error,
  label: string,
): DialectAnalysis {
  if (!(error instanceof ParseError)) throw error;
  const value = error as Error & { readonly code: string; readonly range: SourceRange };
  return {
    columns: [],
    parameters: [],
    diagnostics: [{ code: value.code, message: value.message, severity: "error", range: value.range }],
    semantics: unknownQuerySemantics(value.range, `The SQL could not be parsed by the ${label} grammar.`),
  };
}

function fileParameters(
  tokens: readonly {
    readonly kind: string;
    readonly text: string;
    readonly value: string;
    readonly range: SourceRange;
  }[],
) {
  return tokens
    .filter((token) => token.kind === "parameter")
    .map((token) => ({
      index: token.text.startsWith(":") ? 0 : Number(token.value),
      ...(token.text.startsWith(":") ? { name: token.value } : {}),
      range: token.range,
    }));
}

function publicRuntime<Snapshot extends SchemaSnapshot, Policy>(
  plugin: DialectPlugin<Snapshot, Policy>,
  options: Pick<BrowserDialectRuntime, "mapType" | "server" | "defaultNamespace" | "fold" | "normalizeType">,
): BrowserDialectRuntime {
  return {
    dialectVersion: plugin.grammarVersion,
    module: plugin.sqlModule as BrowserDialectRuntime["module"],
    placeholder: plugin.placeholder,
    parameterOccurrences: (source, snapshot) => plugin.parameterOccurrences!(source, snapshot as unknown as Snapshot),
    analyze: (source, snapshot) =>
      plugin.analyze(source, snapshot as unknown as Snapshot, plugin.defaultTypePolicy, { runtimeValidation: true }),
    ...options,
  };
}

const runtimes: Readonly<Record<PlaygroundDialect, BrowserDialectRuntime>> = Object.freeze({
  postgres: {
    defaultNamespace: "public",
    fold: (name) => name,
    server: (environment = {}) =>
      postgresServerEvidence(environment.version ?? "18.4", [], {
        standardConformingStrings: "on",
        visibilityScope: "current-role",
        ...environment.settings,
      }),
    dialectVersion: POSTGRES_DIALECT_VERSION,
    module: "@typed-sql/postgres",
    placeholder: (index) => `$${index}`,
    parameterOccurrences: (sql) => fileParameters(tokenizePostgres(sql, { sqlFileParameters: true })),
    mapType: (databaseType, snapshot) =>
      mapPostgresType(databaseType, defaultPostgresTypePolicy, snapshot as PostgresSchemaSnapshot),
    analyze(sql, snapshot) {
      try {
        const statement = parsePostgresStatement(sql);
        const postgresSnapshot = snapshot as PostgresSchemaSnapshot;
        const resolved = resolvePostgresStatement(statement, postgresSnapshot, {
          typePolicy: defaultPostgresTypePolicy,
        });
        const analysis = {
          ...resolved,
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "PostgreSQL semantic analysis reported an error.")
            : analyzePostgresSemantics(statement, postgresSnapshot),
        };
        return applyDialectCapabilityStates(analysis, resolvePostgresCapabilities(postgresSnapshot), statement.range);
      } catch (error) {
        return parseFailure(error, PostgresParseError, "PostgreSQL");
      }
    },
  },
  mysql: {
    defaultNamespace: "app",
    fold: (name) => name.toLowerCase(),
    server: (environment = {}) => mySqlServerEvidence(environment.version ?? "9.7.0", environment.settings),
    dialectVersion: MYSQL_DIALECT_VERSION,
    module: "@typed-sql/mysql",
    placeholder: () => "?",
    parameterOccurrences: (sql, snapshot) =>
      fileParameters(
        tokenizeMySql(sql, {
          sqlFileParameters: true,
          ...(typeof snapshot.server.settings.sqlMode === "string"
            ? { sqlMode: snapshot.server.settings.sqlMode }
            : {}),
        }),
      ),
    mapType: (databaseType, snapshot) =>
      mapMySqlType(databaseType, defaultMySqlTypePolicy, snapshot as MySqlSchemaSnapshot),
    analyze(sql, snapshot) {
      try {
        const statement = parseMySqlStatement(sql);
        const mysqlSnapshot = snapshot as MySqlSchemaSnapshot;
        const resolved = resolveMySqlStatement(statement, mysqlSnapshot, { typePolicy: defaultMySqlTypePolicy });
        const analysis = {
          ...resolved,
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "MySQL semantic analysis reported an error.")
            : analyzeMySqlSemantics(statement, mysqlSnapshot),
        };
        return applyDialectCapabilityStates(analysis, resolveMySqlCapabilities(mysqlSnapshot), statement.range);
      } catch (error) {
        return parseFailure(error, MySqlParseError, "MySQL");
      }
    },
  },
  sqlite: {
    defaultNamespace: "main",
    fold: (name) => name.toLowerCase(),
    server: (environment = {}) => {
      if (environment.settings && Object.keys(environment.settings).length)
        throw new TypeError("SQLite playground engine evidence accepts a version only.");
      return sqliteServerEvidence(environment.version ?? "3.54.1");
    },
    dialectVersion: SQLITE_DIALECT_VERSION,
    module: "@typed-sql/sqlite",
    placeholder: () => "?",
    parameterOccurrences: (sql) => fileParameters(tokenizeSqlite(sql, { sqlFileParameters: true })),
    mapType: (databaseType, snapshot, strict) =>
      mapSqliteType(databaseType, defaultSqliteTypePolicy, { strict, schema: snapshot as SqliteSchemaSnapshot }),
    analyze(sql, snapshot) {
      try {
        const statement = parseSqliteStatement(sql);
        const sqliteSnapshot = snapshot as SqliteSchemaSnapshot;
        const resolved = resolveSqliteStatement(statement, sqliteSnapshot, { typePolicy: defaultSqliteTypePolicy });
        const analysis = {
          ...resolved,
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "SQLite semantic analysis reported an error.")
            : analyzeSqliteSemantics(statement, sqliteSnapshot),
        };
        return applyDialectCapabilityStates(analysis, resolveSqliteCapabilities(sqliteSnapshot), statement.range);
      } catch (error) {
        return parseFailure(error, SqliteParseError, "SQLite");
      }
    },
  },
  sqlserver: publicRuntime(sqlserver(), {
    defaultNamespace: "dbo",
    fold(name, snapshot) {
      const collation = String(snapshot?.server.settings.collation ?? "Latin1_General_100_CI_AS");
      let result = /_CI_/iu.test(collation) ? name.toLowerCase() : name;
      if (/_AI(?:_|$)/iu.test(collation)) result = result.normalize("NFD").replace(/\p{M}/gu, "");
      return result;
    },
    server: (environment = DEFAULT_NATIVE_ENVIRONMENTS.sqlserver) =>
      sqlServerServerEvidence(
        environment.version ?? "unknown",
        (environment.settings ?? {}) as unknown as SqlServerServerSettings,
      ),
    mapType: (databaseType) => mapSqlServerType(databaseType),
  }),
  duckdb: publicRuntime(duckdb(), {
    defaultNamespace: "main",
    fold: duckDBAsciiFold,
    server: (environment = DEFAULT_NATIVE_ENVIRONMENTS.duckdb) =>
      duckDBServerEvidence(environment.version ?? "unknown", [], environment.settings ?? {}),
    normalizeType(databaseType, snapshot) {
      const declared = Object.entries(snapshot.types).find(
        ([key, type]) =>
          duckDBAsciiFold(key) === duckDBAsciiFold(databaseType) ||
          duckDBAsciiFold(type.name) === duckDBAsciiFold(databaseType),
      );
      return declared?.[1].kind === "enum"
        ? formatDuckDBType({ kind: "enum", values: declared[1].labels })
        : databaseType;
    },
    mapType: (databaseType) => mapDuckDBType(databaseType),
  }),
});

export function browserDialectRuntime(dialect: PlaygroundDialect): BrowserDialectRuntime {
  return runtimes[dialect];
}
