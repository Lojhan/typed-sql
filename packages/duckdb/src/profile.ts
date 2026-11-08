import { DIALECT_CONTRACT_VERSION, type DialectProfile } from "@typed-sql/core";
import { duckDBParameterOccurrences } from "./parser/parser.js";
import { type DuckDBSchemaSnapshot, parseDuckDBSchemaSnapshot } from "./snapshot.js";
import { DUCKDB_CAPABILITIES, resolveDuckDBCapabilities } from "./support.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeValueType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";

export interface DuckDBProfileOptions {
  readonly typePolicy?: DuckDBTypePolicy;
}
export function duckdbProfile(
  options: DuckDBProfileOptions = {},
): DialectProfile<DuckDBSchemaSnapshot, DuckDBTypePolicy> {
  const policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  return Object.freeze({
    contractVersion: DIALECT_CONTRACT_VERSION,
    id: "duckdb",
    grammarVersion: DUCKDB_DIALECT_VERSION,
    sqlModule: "@typed-sql/duckdb",
    runtimeSqlModule: "@typed-sql/duckdb/query",
    defaultTypePolicy: policy,
    runtimeValueType: duckDBRuntimeValueType,
    capabilities: DUCKDB_CAPABILITIES,
    resolveCapabilities: resolveDuckDBCapabilities,
    placeholder(index: number) {
      if (!Number.isSafeInteger(index) || index < 1 || index > 65535)
        throw new RangeError("DuckDB parameter index must be1–65535");
      return `$${index}`;
    },
    quoteIdentifier(name: string) {
      return `"${name.replaceAll('"', '""')}"`;
    },
    parameterOccurrences: duckDBParameterOccurrences,
    validateSnapshot: parseDuckDBSchemaSnapshot,
  });
}

export type { DuckDBSchemaSnapshot } from "./snapshot.js";
export type { DuckDBTypePolicy } from "./type-policy.js";
export { defaultDuckDBTypePolicy as typePolicy } from "./type-policy.js";
