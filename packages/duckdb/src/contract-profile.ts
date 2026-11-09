import { type ContractInterpreterIdentity, queryContractDigest } from "@typed-sql/analysis";
import { type DuckDBTypePolicy, defaultDuckDBTypePolicy, validateDuckDBTypePolicy } from "./type-policy.js";
import { DUCKDB_VOCABULARY_REVISION } from "./vocabulary-identity.js";

export const duckDBContractAdapterVersion = "duckdb-native-prepare-v3";
export const duckDBContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/duckdb/reconciliation",
  version: "duckdb-contract-reconciliation-v2",
});
/** Pure compatibility identity; importing this entrypoint never loads a native driver. */
export function duckDBContractIdentity(
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "duckdb-guarded-select-profile-v3" }),
    codecHash: queryContractDigest({ codec: "duckdb-logical-types-v1", policy: validateDuckDBTypePolicy(policy) }),
    interpreterHash: queryContractDigest({
      adapter: duckDBContractAdapterVersion,
      vocabulary: DUCKDB_VOCABULARY_REVISION,
    }),
  });
}
