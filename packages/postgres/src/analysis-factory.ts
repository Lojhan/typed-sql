import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectAnalysisContext,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import type { PostgresDialectOptions, PostgresSchemaSnapshot } from "./analysis-options.js";
import { POSTGRES_CAPABILITIES, resolvePostgresCapabilities } from "./capabilities.js";
import type { PostgresCatalogProvider } from "./catalog/provider.js";
import { resolvePostgresExtensionManifests } from "./extension-resolution.js";
import { parseStatement, SqlParseError, tokenize } from "./parser/index.js";
import { validatePostgresSnapshot } from "./profile-snapshot.js";
import { postgresRuntimeValueType } from "./query.js";
import { hasStableRepeatedResult } from "./repeated-inputs.js";
import { resolveStatement } from "./resolver.js";
import { analyzePostgresSemantics } from "./semantics.js";
import { parsePostgresMajor } from "./support.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";
import type { PostgresTypeResolver } from "./type-resolution-factory.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

function matchesMajor(snapshot: PostgresSchemaSnapshot, major: number): boolean {
  const evidence = snapshot.server?.versionKey ?? snapshot.version;
  return evidence !== undefined && parsePostgresMajor(evidence) === major;
}

export function createPostgresDialect(
  catalog: PostgresCatalogProvider,
  types: PostgresTypeResolver,
  options: PostgresDialectOptions = {},
  selectedMajor?: number,
  core = false,
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
        if (selectedMajor !== undefined && !matchesMajor(snapshot, selectedMajor)) {
          const range = { start: 0, end: sql.length, line: 1, column: 1 };
          return {
            columns: [],
            parameters: [],
            diagnostics: [
              {
                code: "TSQ402",
                message: `The selected PostgreSQL analyzer requires major ${selectedMajor}`,
                severity: "error" as const,
                range,
              },
            ],
            semantics: unknownQuerySemantics(range, "PostgreSQL major does not match the selected analyzer."),
          };
        }
        const statement = parseStatement(sql);
        let extensions: ReturnType<typeof resolvePostgresExtensionManifests> | undefined;
        if ((options.extensions?.length ?? 0) > 0) {
          extensions = extensionCache.get(snapshot);
          if (extensions === undefined) {
            extensions = resolvePostgresExtensionManifests(snapshot, options.extensions ?? [], catalog);
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
            unknownRoutineRequiresContract: core,
          },
          catalog,
          types,
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
              : analyzePostgresSemantics(statement, analysisSnapshot),
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
    validateSnapshot(value: unknown) {
      const snapshot = validatePostgresSnapshot(value);
      if (selectedMajor !== undefined && !matchesMajor(snapshot, selectedMajor))
        throw new TypeError(`The selected PostgreSQL analyzer requires major ${selectedMajor}`);
      return snapshot;
    },
  });
}
