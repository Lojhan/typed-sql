import { createDuckDBAnalyzer } from "./analysis-factory.js";
import { duckDBCatalogForVersion } from "./catalog/index.js";
import type { DuckDBProfileOptions as DuckDBDialectOptions } from "./profile.js";

export type { DuckDBProfileOptions as DuckDBDialectOptions } from "./profile.js";
export function duckdb(options: DuckDBDialectOptions = {}) {
  return createDuckDBAnalyzer(options, (snapshot) => duckDBCatalogForVersion(snapshot.server?.versionKey ?? ""));
}

export { type DuckDBBuiltinSignature, duckDBBuiltinCatalog, duckDBBuiltinSignatures } from "./catalog/index.js";
export { DuckDBValueError, decodeDuckDBValue } from "./codecs.js";
export type { DuckDBType, DuckDBTypeField } from "./native-types.js";
export { duckDBAsciiFold, formatDuckDBType, parseDuckDBType } from "./native-types.js";
export { sql } from "./query.js";
export type { DuckDBSchemaSnapshot } from "./snapshot.js";
export { parseDuckDBSchemaSnapshot } from "./snapshot.js";
export {
  DUCKDB_CAPABILITIES,
  DUCKDB_SUPPORT_POLICY,
  duckDBServerEvidence,
  duckDBVersionSupport,
  resolveDuckDBCapabilities,
} from "./support.js";
export type { DuckDBTypePolicy } from "./type-policy.js";
export {
  defaultDuckDBTypePolicy as typePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeType,
  duckDBTypeScript,
  mapDuckDBType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
export { DUCKDB_DIALECT_VERSION } from "./version.js";
