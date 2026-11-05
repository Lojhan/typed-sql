import {
  applyDialectCapabilityStates,
  type DialectAnalysis,
  type SourceRange,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { resolveMySqlCapabilities } from "../../../../packages/mysql/src/capabilities.js";
import type { MySqlSchemaSnapshot } from "../../../../packages/mysql/src/index.js";
import {
  SqlParseError as MySqlParseError,
  parseStatement as parseMySqlStatement,
} from "../../../../packages/mysql/src/parser/index.js";
import { tokenize as tokenizeMySql } from "../../../../packages/mysql/src/parser/tokenizer.js";
import { resolveMySqlStatement } from "../../../../packages/mysql/src/resolver.js";
import { analyzeMySqlSemantics } from "../../../../packages/mysql/src/semantics.js";
import { defaultMySqlTypePolicy, mapMySqlType } from "../../../../packages/mysql/src/type-policy.js";
import { MYSQL_DIALECT_VERSION } from "../../../../packages/mysql/src/version.js";
import { resolvePostgresCapabilities } from "../../../../packages/postgres/src/capabilities.js";
import type { PostgresSchemaSnapshot } from "../../../../packages/postgres/src/index.js";
import {
  SqlParseError as PostgresParseError,
  parseStatement as parsePostgresStatement,
} from "../../../../packages/postgres/src/parser/index.js";
import { tokenize as tokenizePostgres } from "../../../../packages/postgres/src/parser/tokenizer.js";
import { resolveStatement as resolvePostgresStatement } from "../../../../packages/postgres/src/resolver.js";
import { analyzePostgresSemantics } from "../../../../packages/postgres/src/semantics.js";
import { defaultPostgresTypePolicy, mapPostgresType } from "../../../../packages/postgres/src/type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "../../../../packages/postgres/src/version.js";
import type { SchemaSnapshotV2 } from "../../../../packages/schema/src/model.js";
import { resolveSqliteCapabilities } from "../../../../packages/sqlite/src/capabilities.js";
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

export type PlaygroundDialect = "postgres" | "mysql" | "sqlite";

export interface BrowserDialectRuntime {
  readonly dialectVersion: string;
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

const runtimes: Readonly<Record<PlaygroundDialect, BrowserDialectRuntime>> = Object.freeze({
  postgres: {
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
});

export function browserDialectRuntime(dialect: PlaygroundDialect): BrowserDialectRuntime {
  return runtimes[dialect];
}
