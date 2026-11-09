import {
  applyDialectCapabilityStates,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { unmodeledMySqlSqlModes } from "./capabilities.js";
import type { MySqlCatalogProvider } from "./catalog/provider.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { type MySqlProfileOptions as MySqlDialectOptions, type MySqlSchemaSnapshot, mysqlProfile } from "./profile.js";
import { hasStableRepeatedResult } from "./repeated-inputs.js";
import { resolveMySqlStatement } from "./resolver.js";
import { analyzeMySqlSemantics } from "./semantics.js";
import { parseMySqlVersion } from "./support.js";
import type { MySqlTypePolicy } from "./type-policy.js";

function matchesSeries(snapshot: MySqlSchemaSnapshot, series: string): boolean {
  const evidence = snapshot.server?.versionKey ?? snapshot.version;
  const version = evidence === undefined ? undefined : parseMySqlVersion(evidence);
  return version !== undefined && `${version[0]}.${version[1]}` === series;
}
export function createMySqlDialect(
  catalog: MySqlCatalogProvider,
  options: MySqlDialectOptions = {},
  selectedSeries?: string,
  core = false,
): DialectPlugin<MySqlSchemaSnapshot, MySqlTypePolicy> {
  const profile = mysqlProfile(options);
  const defaultTypePolicy = profile.defaultTypePolicy;
  return Object.freeze({
    ...profile,
    validateSnapshot(value: unknown) {
      const snapshot = profile.validateSnapshot(value);
      if (selectedSeries !== undefined && !matchesSeries(snapshot, selectedSeries))
        throw new TypeError(`The selected MySQL analyzer requires series ${selectedSeries}`);
      return snapshot;
    },
    analyze(
      sql: string,
      snapshot: MySqlSchemaSnapshot,
      policy = defaultTypePolicy,
      context: DialectAnalysisContext = {},
    ) {
      try {
        if (selectedSeries !== undefined && !matchesSeries(snapshot, selectedSeries)) {
          const range = { start: 0, end: sql.length, line: 1, column: 1 };
          return {
            columns: [],
            parameters: [],
            diagnostics: [
              {
                code: "TSQ402",
                message: `The selected MySQL analyzer requires series ${selectedSeries}`,
                severity: "error" as const,
                range,
              },
            ],
            semantics: unknownQuerySemantics(range, "MySQL engine series does not match the selected analyzer."),
          };
        }
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
        const resolved = resolveMySqlStatement(
          statement,
          snapshot,
          {
            typePolicy: policy,
            runtimeValidation: context.runtimeValidation === true,
            unknownRoutineRequiresContract: core,
          },
          catalog,
        );
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
