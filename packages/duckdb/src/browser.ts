import { createDuckDBDialect, type DuckDBDialectOptions } from "./analysis-factory.js";
import { defaultDuckDBCatalog } from "./catalog/index.js";

export type { DuckDBDialectOptions } from "./analysis-factory.js";
export function duckdb(options: DuckDBDialectOptions = {}) {
  return createDuckDBDialect(defaultDuckDBCatalog, options);
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
