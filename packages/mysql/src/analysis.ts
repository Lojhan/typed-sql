import {
  applyDialectCapabilityStates,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { unmodeledMySqlSqlModes } from "./capabilities.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { type MySqlProfileOptions as MySqlDialectOptions, type MySqlSchemaSnapshot, mysqlProfile } from "./profile.js";
import { hasStableRepeatedResult } from "./repeated-inputs.js";
import { resolveMySqlStatement } from "./resolver.js";
import { analyzeMySqlSemantics } from "./semantics.js";
import type { MySqlTypePolicy } from "./type-policy.js";

export type {
  MySqlBulkCapability,
  MySqlBulkProgress,
  MySqlBulkResult,
  MySqlLoadDataOptions,
} from "./bulk.js";
export { mysqlBulk } from "./bulk.js";
export type { MySqlCoreCatalog } from "./catalog/index.js";
export { MYSQL_CORE_CATALOG_FORMAT_VERSION, mySqlCoreCatalog } from "./catalog/index.js";
export type { MySqlProfileOptions as MySqlDialectOptions, MySqlSchemaSnapshot } from "./profile.js";
export { MySqlRuntimeCompatibilityError, MySqlWarningError, MySqlWarningInspectionError } from "./runtime.js";
export { MYSQL_DIALECT_VERSION } from "./version.js";
export function mysql(options: MySqlDialectOptions = {}): DialectPlugin<MySqlSchemaSnapshot, MySqlTypePolicy> {
  const profile = mysqlProfile(options);
  const defaultTypePolicy = profile.defaultTypePolicy;
  return Object.freeze({
    ...profile,
    analyze(
      sql: string,
      snapshot: MySqlSchemaSnapshot,
      policy = defaultTypePolicy,
      context: DialectAnalysisContext = {},
    ) {
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
        const resolved = resolveMySqlStatement(statement, snapshot, {
          typePolicy: policy,
          runtimeValidation: context.runtimeValidation === true,
        });
        const analysis = {
          ...resolved,
          ...(hasStableRepeatedResult(sql, statement, context.repeatedFragmentRanges)
            ? { repeatedResultShapeStable: true as const }
            : {}),
          semantics: resolved.diagnostics.some(({ severity }) => severity === "error")
            ? unknownQuerySemantics(statement.range, "MySQL semantic analysis reported an error.")
            : analyzeMySqlSemantics(statement, snapshot),
        };
        return applyDialectCapabilityStates(analysis, profile.resolveCapabilities!(snapshot), statement.range);
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
