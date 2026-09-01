import {
  applyDialectCapabilityStates,
  DIALECT_CONTRACT_VERSION,
  type DialectPlugin,
  unknownQuerySemantics,
} from "@typed-sql/core";
import { parseSchemaSnapshot, type SchemaSnapshot } from "@typed-sql/schema";
import { assertPostgresServerEvidence, POSTGRES_CAPABILITIES, resolvePostgresCapabilities } from "./capabilities.js";
import { type PostgresExtensionManifest, resolvePostgresExtensionManifests } from "./extensions.js";
import { parseStatement, SqlParseError } from "./parser/index.js";
import { resolveStatement } from "./resolver.js";
import { analyzePostgresSemantics } from "./semantics.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

export type {
  PostgresCopyCapability,
  PostgresCopyFromOptions,
  PostgresCopyProgress,
  PostgresCopyResult,
  PostgresCopyToOptions,
} from "./bulk.js";
export { postgresCopy } from "./bulk.js";
export type { PostgresCoreCatalog } from "./catalog/index.js";
export { POSTGRES_CORE_CATALOG_FORMAT_VERSION, postgresCoreCatalog } from "./catalog/index.js";
export type {
  PostgresExtensionCast,
  PostgresExtensionCodec,
  PostgresExtensionContribution,
  PostgresExtensionIssue,
  PostgresExtensionManifest,
  PostgresExtensionOperator,
  PostgresExtensionQueryable,
  ResolvedPostgresExtensions,
} from "./extensions.js";
export {
  definePostgresExtensionManifest,
  introspectPostgresExtensionManifests,
  POSTGRES_EXTENSION_MANIFEST_FORMAT_VERSION,
  PostgresExtensionResolutionError,
  resolvePostgresExtensionManifests,
} from "./extensions.js";
export { POSTGRES_DIALECT_VERSION } from "./version.js";

export type PostgresSchemaSnapshot = SchemaSnapshot & { readonly dialect: "postgres" };
export interface PostgresDialectOptions {
  readonly typePolicy?: PostgresTypePolicy;
  readonly versionPolicy?: import("./capabilities.js").PostgresVersionPolicy;
  readonly extensions?: readonly PostgresExtensionManifest[];
}

function validatePostgresSnapshot(value: unknown): PostgresSchemaSnapshot {
  const snapshot = parseSchemaSnapshot(value);
  if (snapshot.dialect !== "postgres") {
    throw new TypeError(`@typed-sql/postgres cannot use a ${snapshot.dialect} schema snapshot`);
  }
  if (snapshot.dialectVersion !== undefined && snapshot.dialectVersion !== POSTGRES_DIALECT_VERSION) {
    throw new TypeError(
      `@typed-sql/postgres grammar ${POSTGRES_DIALECT_VERSION} cannot use snapshot dialectVersion ${snapshot.dialectVersion}`,
    );
  }
  if (snapshot.server !== undefined && snapshot.server.product !== "postgres") {
    throw new TypeError(`@typed-sql/postgres cannot use ${snapshot.server.product} server evidence`);
  }
  if (snapshot.server !== undefined) assertPostgresServerEvidence(snapshot.server);
  return snapshot as PostgresSchemaSnapshot;
}

export function postgres(
  options: PostgresDialectOptions = {},
): DialectPlugin<PostgresSchemaSnapshot, PostgresTypePolicy> {
  const defaultTypePolicy = options.typePolicy ?? defaultPostgresTypePolicy;
  const versionPolicy = options.versionPolicy ?? "stable";
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "postgres",
    grammarVersion: POSTGRES_DIALECT_VERSION,
    sqlModule: "@typed-sql/postgres",
    capabilities: POSTGRES_CAPABILITIES,
    resolveCapabilities: (snapshot: PostgresSchemaSnapshot) => resolvePostgresCapabilities(snapshot, versionPolicy),
    defaultTypePolicy,
    placeholder(index: number): string {
      if (!Number.isInteger(index) || index < 1) throw new RangeError("PostgreSQL parameter indexes start at 1");
      return `$${index}`;
    },
    quoteIdentifier(identifier: string): string {
      return `"${identifier.replaceAll('"', '""')}"`;
    },
    analyze(sql: string, snapshot: PostgresSchemaSnapshot, policy = defaultTypePolicy) {
      try {
        const statement = parseStatement(sql);
        const extensions =
          (options.extensions?.length ?? 0) === 0
            ? undefined
            : resolvePostgresExtensionManifests(snapshot, options.extensions ?? []);
        const analysisSnapshot = extensions?.snapshot ?? snapshot;
        const extensionIssues = extensions?.issues ?? [];
        const resolved = resolveStatement(statement, analysisSnapshot, { typePolicy: policy });
        const analysis = {
          ...resolved,
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
        return applyDialectCapabilityStates(
          analysis,
          resolvePostgresCapabilities(snapshot, versionPolicy),
          statement.range,
        );
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

export { sql } from "@typed-sql/core";
export type { SchemaSnapshot } from "@typed-sql/schema";
export { parseSchemaSnapshot } from "@typed-sql/schema";
export type { PostgresVersionPolicy } from "./capabilities.js";
export { parsePostgresMajor, postgresServerEvidence, resolvePostgresCapabilities } from "./capabilities.js";
export type {
  PostgresDriverImporter,
  PostgresDriverModule,
  PostgresIntrospectionClient,
  PostgresIntrospectionPool,
  PostgresQueryable,
  PostgresQueryResult,
  PostgresSchemaProviderOptions,
} from "./provider.js";
export { introspectPostgres, loadPostgresDriver, PostgresSchemaProvider, postgresCatalogQueries } from "./provider.js";
export type { PostgresQuerySemanticResolverOptions, PostgresRoutedDatabaseOptions } from "./routing.js";
export {
  createPostgresQuerySemanticResolver,
  createPostgresRoutedDatabase,
  isPostgresRetryableTransactionError,
} from "./routing.js";
export type { PostgresVersionSupport } from "./support.js";
export { POSTGRES_SUPPORT_POLICY, postgresVersionSupport } from "./support.js";
export type { PostgresTypePolicy } from "./type-policy.js";
export {
  defaultPostgresTypePolicy,
  defaultPostgresTypePolicy as typePolicy,
  isKnownPostgresType,
  mapPostgresType,
} from "./type-policy.js";
