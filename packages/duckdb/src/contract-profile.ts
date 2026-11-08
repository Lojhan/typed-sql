import { type ContractInterpreterIdentity, queryContractDigest } from "@typed-sql/analysis";
import { type DuckDBTypePolicy, defaultDuckDBTypePolicy, validateDuckDBTypePolicy } from "./type-policy.js";

export const duckDBContractAdapterVersion = "duckdb-native-prepare-v1";
export const duckDBContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/duckdb/reconciliation",
  version: "duckdb-contract-reconciliation-v1",
});
/** Pure compatibility identity; importing this entrypoint never loads a native driver. */
export function duckDBContractIdentity(
  policy: DuckDBTypePolicy = defaultDuckDBTypePolicy,
): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "duckdb-builtin-expression-profile-v1" }),
    codecHash: queryContractDigest({ codec: "duckdb-logical-types-v1", policy: validateDuckDBTypePolicy(policy) }),
    interpreterHash: queryContractDigest(duckDBContractAdapterVersion),
  });
}
