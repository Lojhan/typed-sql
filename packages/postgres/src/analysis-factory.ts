import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import type { PostgresDialectOptions, PostgresSchemaSnapshot } from "./analysis-options.js";
import { POSTGRES_CAPABILITIES, resolvePostgresCapabilities } from "./capabilities.js";
import type { PostgresNativeCatalog } from "./catalog/native-resolution.js";
import { resolvePostgresExtensionManifests } from "./extensions.js";
import { parseStatement, SqlParseError, tokenize } from "./parser/index.js";
import { validatePostgresSnapshot } from "./profile-snapshot.js";
import { postgresRuntimeValueType } from "./query.js";
import { hasStableRepeatedResult } from "./repeated-inputs.js";
import { resolveStatement } from "./resolver-engine.js";
import { analyzePostgresSemantics } from "./semantics-engine.js";
import { parsePostgresMajor } from "./support.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

export function createPostgresAnalyzer(
  options: PostgresDialectOptions,
  nativeCatalog: PostgresNativeCatalog,
  requiredMajor?: number,
): DialectPlugin<PostgresSchemaSnapshot, PostgresTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultPostgresTypePolicy;
  const versionPolicy = options.versionPolicy ?? "stable";
  const capabilityCache = new WeakMap<PostgresSchemaSnapshot, ReturnType<typeof resolvePostgresCapabilities>>();
  const extensionCache = new WeakMap<PostgresSchemaSnapshot, ReturnType<typeof resolvePostgresExtensionManifests>>();
  const capabilitiesFor = (snapshot: PostgresSchemaSnapshot): ReturnType<typeof resolvePostgresCapabilities> => {
    const cached = capabilityCache.get(snapshot);
    if (cached !== undefined) return cached;
    const resolved = resolvePostgresCapabilities(snapshot, versionPolicy);
    capabilityCache.set(snapshot, resolved);
    return resolved;
  };
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "postgres",
    grammarVersion: POSTGRES_DIALECT_VERSION,
    sqlModule: "@typed-sql/postgres",
    runtimeSqlModule: "@typed-sql/postgres/query",
    capabilities: POSTGRES_CAPABILITIES,
    resolveCapabilities: capabilitiesFor,
    defaultTypePolicy,
    runtimeValueType: postgresRuntimeValueType,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("PostgreSQL parameter indexes start at 1");
      return `$${index}`;
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
    analyze(
      sql: string,
      snapshot: PostgresSchemaSnapshot,
      policy = defaultTypePolicy,
      context: DialectAnalysisContext = {},
    ) {
      try {
        const statement = parseStatement(sql);
        if (
          requiredMajor !== undefined &&
          parsePostgresMajor(snapshot.server?.versionKey ?? snapshot.version ?? "") !== requiredMajor
        ) {
          return {
            columns: [],
            parameters: [],
            diagnostics: [
              {
                code: "TSQ402",
                severity: "error" as const,
                message: `This analyzer requires PostgreSQL ${requiredMajor} server-version evidence.`,
                range: statement.range,
              },
            ],
            semantics: unknownQuerySemantics(
              statement.range,
              "The snapshot does not match the selected PostgreSQL analyzer.",
            ),
          };
        }
        let extensions: ReturnType<typeof resolvePostgresExtensionManifests> | undefined;
        if ((options.extensions?.length ?? 0) > 0) {
          extensions = extensionCache.get(snapshot);
          if (extensions === undefined) {
            extensions = resolvePostgresExtensionManifests(snapshot, options.extensions ?? []);
            extensionCache.set(snapshot, extensions);
          }
        }
        const analysisSnapshot = extensions?.snapshot ?? snapshot;
        const extensionIssues = extensions?.issues ?? [];
        const resolved = resolveStatement(
          statement,
          analysisSnapshot,
          {
            typePolicy: policy,
            runtimeValidation: context.runtimeValidation === true,
          },
          nativeCatalog,
        );
        const analysis = {
          ...resolved,
          ...(hasStableRepeatedResult(sql, statement, context.repeatedFragmentRanges)
            ? { repeatedResultShapeStable: true as const }
            : {}),
          diagnostics: [
            ...resolved.diagnostics,
            ...extensionIssues.map(({ code, message }) => ({
              code,
              message,
              severity: "error" as const,
              range: statement.range,
            })),
          ],
          semantics:
            resolved.diagnostics.some(({ severity }) => severity === "error") || extensionIssues.length > 0
              ? unknownQuerySemantics(statement.range, "PostgreSQL semantic analysis reported an error.")
              : analyzePostgresSemantics(statement, analysisSnapshot, nativeCatalog),
        };
        return applyDialectCapabilityStates(analysis, capabilitiesFor(snapshot), statement.range);
      } catch (error) {
        if (!(error instanceof SqlParseError)) throw error;
        return {
          columns: [],
          parameters: [],
          diagnostics: [{ code: error.code, message: error.message, severity: "error" as const, range: error.range }],
          semantics: unknownQuerySemantics(error.range, "The SQL could not be parsed by the PostgreSQL grammar."),
        };
      }
    },
    validateSnapshot: validatePostgresSnapshot,
  });
}
