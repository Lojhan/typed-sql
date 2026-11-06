import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { resolveSqlServerCapabilities, SQLSERVER_CAPABILITIES } from "./capabilities.js";
import { parseStatement, SqlServerParseError, tokenize, walkStatement } from "./parser/index.js";
import { sqlServerRenderer } from "./query.js";
import { resolveSqlServerStatement } from "./resolver.js";
import { analyzeSqlServerSemantics } from "./semantics.js";
import { parseSqlServerSchemaSnapshot, type SqlServerSchemaSnapshot } from "./snapshot.js";
import {
  defaultSqlServerTypePolicy,
  type SqlServerTypePolicy,
  sqlServerRuntimeValueType,
  validateSqlServerTypePolicy,
} from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";
export interface SqlServerDialectOptions {
  readonly typePolicy?: SqlServerTypePolicy;
}
export function sqlserver(
  options: SqlServerDialectOptions = {},
): DialectPlugin<SqlServerSchemaSnapshot, SqlServerTypePolicy> {
  const policy = validateSqlServerTypePolicy(options.typePolicy ?? defaultSqlServerTypePolicy);
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "sqlserver",
    grammarVersion: SQLSERVER_DIALECT_VERSION,
    sqlModule: "@typed-sql/sqlserver",
    runtimeSqlModule: "@typed-sql/sqlserver/query",
    capabilities: SQLSERVER_CAPABILITIES,
    resolveCapabilities: resolveSqlServerCapabilities,
    defaultTypePolicy: policy,
    runtimeValueType: sqlServerRuntimeValueType,
    placeholder: sqlServerRenderer.placeholder,
    quoteIdentifier: sqlServerRenderer.quoteIdentifier,
    parameterOccurrences(source: string) {
      return tokenize(source, { sqlFileParameters: true })
        .filter((token) => token.kind === "parameter")
        .map((token) => ({
          index: /^@__typed_sql_\d+$/u.test(token.text) || token.text === "?" ? Number(token.value) : 0,
          ...(/^@__typed_sql_\d+$/u.test(token.text) || token.text === "?" ? {} : { name: token.text.slice(1) }),
          range: token.range,
        }));
    },
    analyze(
      source: string,
      snapshot: SqlServerSchemaSnapshot,
      typePolicy = policy,
      context: DialectAnalysisContext = {},
    ) {
      try {
        const statement = parseStatement(source);
        const analysis = resolveSqlServerStatement(statement, snapshot, {
          typePolicy,
          runtimeValidation: context.runtimeValidation === true,
        });
        const semantics = analysis.diagnostics.some((d) => d.severity === "error")
          ? unknownQuerySemantics(statement.range, "SQL Server analysis reported an error")
          : analyzeSqlServerSemantics(statement, snapshot);
        let repeatedResultShapeStable = true;
        for (const range of context.repeatedFragmentRanges ?? []) {
          // A repeated JOIN/CTE source can change SELECT * width even if its scalar expressions
          // do not overlap a projection. Only complete predicate-contained ranges have this proof.
          if (
            statement.kind === "select" &&
            ![statement.where, statement.having, ...statement.joins.map((join) => join.on)].some(
              (predicate) => predicate && range.start >= predicate.range.start && range.end <= predicate.range.end,
            )
          )
            repeatedResultShapeStable = false;
          walkStatement(statement, {
            expression: (expression) => {
              if (
                expression.range.start >= range.start &&
                expression.range.end <= range.end &&
                !statementHasSafeRepeated(statement, expression)
              )
                repeatedResultShapeStable = false;
            },
          });
        }
        const states = resolveSqlServerCapabilities(snapshot);
        const conservative = states.syntax?.level === "conservative";
        return applyDialectCapabilityStates(
          {
            ...analysis,
            diagnostics: conservative
              ? [
                  ...analysis.diagnostics,
                  {
                    code: "TSQ402",
                    message: states.syntax!.reason,
                    range: statement.range,
                    severity: "error" as const,
                  },
                ]
              : analysis.diagnostics,
            semantics: conservative
              ? unknownQuerySemantics(statement.range, "SQL Server environment evidence is conservative")
              : semantics,
            ...(repeatedResultShapeStable ? { repeatedResultShapeStable: true as const } : {}),
          },
          states,
          statement.range,
        );
      } catch (error) {
        if (!(error instanceof SqlServerParseError)) throw error;
        return {
          columns: [],
          parameters: [],
          diagnostics: [{ code: error.code, message: error.message, range: error.range, severity: "error" as const }],
          semantics: unknownQuerySemantics(error.range, "The T-SQL statement did not parse"),
        };
      }
    },
    validateSnapshot: parseSqlServerSchemaSnapshot,
  });
}
/** Repeated scalar lists cannot alter a WHERE/JOIN predicate's output row shape. */
function statementHasSafeRepeated(
  statement: ReturnType<typeof parseStatement>,
  expression: Parameters<NonNullable<Parameters<typeof walkStatement>[1]["expression"]>>[0],
): boolean {
  if (statement.kind === "insert")
    return statement.values.some((row) =>
      row.some((value) => expression.range.start >= value.range.start && expression.range.end <= value.range.end),
    );
  if (statement.kind !== "select") return false;
  const projections = statement.projections;
  return (
    !projections.some(
      (projection) => expression.range.start >= projection.range.start && expression.range.end <= projection.range.end,
    ) &&
    !statement.group.some(
      (group) => expression.range.start >= group.range.start && expression.range.end <= group.range.end,
    )
  );
}

export { sql } from "@typed-sql/core";
export type { SqlServerServerSettings } from "./capabilities.js";
export {
  assertSqlServerServerEvidence,
  resolveSqlServerCapabilities,
  SQLSERVER_CAPABILITIES,
  sqlServerServerEvidence,
} from "./capabilities.js";
export type { SqlServerNativeType } from "./native-types.js";
export { parseSqlServerNativeType, requireSqlServerNativeType, validateSqlServerDecimal } from "./native-types.js";
export { normalizeSqlServerValue, sqlServerRenderer } from "./query.js";
export type { SqlServerSchemaSnapshot } from "./snapshot.js";
export { parseSqlServerSchemaSnapshot } from "./snapshot.js";
export type { SqlServerVersion } from "./support.js";
export { parseSqlServerVersion, SQLSERVER_LANGUAGE_SUPPORT, sqlServerVersionSupport } from "./support.js";
export type { SqlServerTypePolicy } from "./type-policy.js";
export {
  defaultSqlServerTypePolicy,
  defaultSqlServerTypePolicy as typePolicy,
  mapSqlServerType,
  sqlServerRuntimeValueType,
  validateSqlServerTypePolicy,
} from "./type-policy.js";
export { SQLSERVER_DIALECT_VERSION } from "./version.js";
