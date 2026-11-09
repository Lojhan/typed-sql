import { createPostgresDialect } from "./analysis-factory.js";
import type { PostgresDialectOptions } from "./analysis-options.js";
import { postgresCatalogProvider } from "./catalog/index.js";
import { parsePostgresMajor as vocabularyMajor } from "./support.js";
import { postgresTypeResolver } from "./type-resolution.js";
import { postgresVocabulary } from "./vocabulary/index.js";

export type { PostgresDialectOptions, PostgresSchemaSnapshot } from "./analysis-options.js";
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
export type { PostgresRuntimeCompatibilityReason } from "./runtime-compatibility.js";
export {
  PostgresRuntimeCompatibilityError,
  parsePostgresRuntimeSnapshot,
  validatePostgresRuntimeCompatibility,
} from "./runtime-compatibility.js";
export { POSTGRES_DIALECT_VERSION } from "./version.js";

export function postgres(options: PostgresDialectOptions = {}) {
  return createPostgresDialect(
    postgresCatalogProvider,
    postgresTypeResolver,
    options,
    undefined,
    false,
    (snapshot) => postgresVocabulary(vocabularyMajor(snapshot.server?.versionKey ?? snapshot.version ?? "18"))?.lookup,
  );
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
