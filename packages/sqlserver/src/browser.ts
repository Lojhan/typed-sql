import { createSqlServerDialect } from "./analysis-factory.js";
import type { SqlServerProfileOptions as SqlServerDialectOptions } from "./profile.js";

export type { SqlServerProfileOptions as SqlServerDialectOptions } from "./profile.js";
export function sqlserver(options: SqlServerDialectOptions = {}) {
  return createSqlServerDialect(options);
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
