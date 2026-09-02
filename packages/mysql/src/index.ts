import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { parseSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import {
  assertMySqlServerEvidence,
  MYSQL_CAPABILITIES,
  resolveMySqlCapabilities,
  unmodeledMySqlSqlModes,
} from "./capabilities.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { resolveMySqlStatement } from "./resolver.js";
import { analyzeMySqlSemantics } from "./semantics.js";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

export type {
  MySqlBulkCapability,
  MySqlBulkProgress,
  MySqlBulkResult,
  MySqlLoadDataOptions,
} from "./bulk.js";
export { mysqlBulk } from "./bulk.js";
export type { MySqlCoreCatalog } from "./catalog/index.js";
export { MYSQL_CORE_CATALOG_FORMAT_VERSION, mySqlCoreCatalog } from "./catalog/index.js";
export { MySqlRuntimeCompatibilityError, MySqlWarningError, MySqlWarningInspectionError } from "./runtime.js";
export { MYSQL_DIALECT_VERSION } from "./version.js";
export type MySqlSchemaSnapshot = SchemaSnapshot & { readonly dialect: "mysql" };

export interface MySqlDialectOptions {
  readonly typePolicy?: MySqlTypePolicy;
  readonly versionPolicy?: import("./support.js").MySqlVersionPolicy;
}

function validateMySqlSnapshot(value: unknown): MySqlSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "mysql")
    throw new TypeError(`@typed-sql/mysql cannot use a ${snapshot.dialect} schema snapshot`);
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== MYSQL_DIALECT_VERSION) {
    throw new TypeError(
      `@typed-sql/mysql grammar ${MYSQL_DIALECT_VERSION} cannot use snapshot dialectVersion ${snapshot.dialectVersion}`,
    );
  }
  if (snapshot.server !== undefined && snapshot.server.product !== "mysql") {
    throw new TypeError(`@typed-sql/mysql cannot use ${snapshot.server.product} server evidence`);
  }
  if (snapshot.server !== undefined) assertMySqlServerEvidence(snapshot.server);
  return snapshot as MySqlSchemaSnapshot;
}

export function mysql(options: MySqlDialectOptions = {}): DialectPlugin<MySqlSchemaSnapshot, MySqlTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultMySqlTypePolicy;
  const versionPolicy = options.versionPolicy ?? "stable";
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "mysql",
    grammarVersion: MYSQL_DIALECT_VERSION,
    sqlModule: "@typed-sql/mysql",
    capabilities: MYSQL_CAPABILITIES,
    resolveCapabilities: (snapshot: MySqlSchemaSnapshot) => resolveMySqlCapabilities(snapshot, versionPolicy),
    defaultTypePolicy,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("MySQL parameter indexes start at 1");
      return "?";
    },
    quoteIdentifier(identifier: string): string {
      return `\`${identifier.replaceAll("`", "``")}\``;
    },
    analyze(sql: string, snapshot: MySqlSchemaSnapshot, policy = defaultTypePolicy) {
      try {
        const sqlMode = snapshot.server?.settings.sqlMode;
        const unmodeledModes = typeof sqlMode === "string" ? unmodeledMySqlSqlModes(sqlMode) : [];
        if (unmodeledModes.length > 0) {
          const range = { start: 0, end: sql.length, line: 1, column: 1 };
          return {
            columns: [],
            parameters: [],
            diagnostics: [
              {
                code: "TSQ407",
                message: `Exact MySQL analysis does not cover these sql_mode values: ${unmodeledModes.join(", ")}.`,
                severity: "error" as const,
                range,
                suggestion: "Use a modeled SQL mode or remove the query from exact static analysis.",
              },
            ],
            semantics: unknownQuerySemantics(range, "The recorded MySQL SQL mode is not modeled."),
          };
        }
        const statement = parseStatement(sql, { ...(typeof sqlMode === "string" ? { sqlMode } : {}) });
        const resolved = resolveMySqlStatement(statement, snapshot, { typePolicy: policy });
        const analysis = {
          ...resolved,
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "MySQL semantic analysis reported an error.")
            : analyzeMySqlSemantics(statement, snapshot),
        };
        return applyDialectCapabilityStates(
          analysis,
          resolveMySqlCapabilities(snapshot, versionPolicy),
          statement.range,
        );
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        return {
          columns: [],
          parameters: [],
          diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }],
          semantics: unknownQuerySemantics(error.range, "The SQL could not be parsed by the MySQL grammar."),
        };
      }
    },
    validateSnapshot: validateMySqlSnapshot,
  });
}

export { sql } from "@typed-sql/core";
export type { SchemaSnapshot } from "@typed-sql/schema";
export { parseSchemaSnapshot } from "@typed-sql/schema";
export type { MySqlServerEdition, MySqlServerEvidenceOptions } from "./capabilities.js";
export { mySqlServerEvidence, resolveMySqlCapabilities } from "./capabilities.js";
export type {
  MySqlIntrospectionCatalog,
  MySqlIntrospectionDiagnostic,
  MySqlIntrospectionResult,
  MySqlQueryable,
  MySqlSchemaProviderOptions,
} from "./provider.js";
export { introspectMySql, MySqlSchemaProvider, mysqlCatalogQueries } from "./provider.js";
export type { MySqlQuerySemanticResolverOptions, MySqlRoutedDatabaseOptions } from "./routing.js";
export {
  createMySqlQuerySemanticResolver,
  createMySqlRoutedDatabase,
  isMySqlRetryableTransactionError,
} from "./routing.js";
export type { MySqlVersionPolicy, MySqlVersionSupport } from "./support.js";
export { MYSQL_SUPPORT_POLICY, mySqlVersionSupport, parseMySqlVersion } from "./support.js";
export type { MySqlTypePolicy } from "./type-policy.js";
export {
  defaultMySqlTypePolicy,
  defaultMySqlTypePolicy as typePolicy,
  isKnownMySqlType,
  mapMySqlType,
} from "./type-policy.js";
