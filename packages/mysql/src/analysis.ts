import { createMySqlDialect } from "./analysis-factory.js";
import { defaultMySqlCatalog } from "./catalog/index.js";
import type { MySqlProfileOptions as MySqlDialectOptions } from "./profile.js";
export function mysql(options: MySqlDialectOptions = {}) {
  return createMySqlDialect(defaultMySqlCatalog, options);
}

export { sql } from "@typed-sql/core";
export type { SchemaSnapshot } from "@typed-sql/schema";
export { parseSchemaSnapshot } from "@typed-sql/schema";
export type {
  MySqlBulkCapability,
  MySqlBulkProgress,
  MySqlBulkResult,
  MySqlLoadDataOptions,
} from "./bulk.js";
export { mysqlBulk } from "./bulk.js";
export type { MySqlServerEdition, MySqlServerEvidenceOptions } from "./capabilities.js";
export { mySqlServerEvidence, resolveMySqlCapabilities } from "./capabilities.js";
export type { MySqlCoreCatalog } from "./catalog/index.js";
export { MYSQL_CORE_CATALOG_FORMAT_VERSION, mySqlCoreCatalog } from "./catalog/index.js";
export type { MySqlProfileOptions as MySqlDialectOptions, MySqlSchemaSnapshot } from "./profile.js";
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
export { MySqlRuntimeCompatibilityError, MySqlWarningError, MySqlWarningInspectionError } from "./runtime.js";
export type { MySqlVersionPolicy, MySqlVersionSupport } from "./support.js";
export { MYSQL_SUPPORT_POLICY, mySqlVersionSupport, parseMySqlVersion } from "./support.js";
export type { MySqlTypePolicy } from "./type-policy.js";
export {
  defaultMySqlTypePolicy,
  defaultMySqlTypePolicy as typePolicy,
  isKnownMySqlType,
  mapMySqlType,
} from "./type-policy.js";
export { MYSQL_DIALECT_VERSION } from "./version.js";
