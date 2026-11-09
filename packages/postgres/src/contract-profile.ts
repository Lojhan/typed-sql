import { type ContractInterpreterIdentity, queryContractDigest } from "@typed-sql/analysis";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./policy.js";
import { POSTGRES_VOCABULARY_REVISION } from "./vocabulary-identity.js";
/** Shared pure compatibility revisions. No analyzer or native client is imported. */
export const postgresContractAdapterVersion = "postgres-contract-describe-v3";
export const postgresContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/postgres/reconciliation",
  version: "postgres-contract-reconciliation-v3",
});
export function postgresContractIdentity(
  policy: PostgresTypePolicy = defaultPostgresTypePolicy,
): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "postgres-guarded-select-profile-v2" }),
    codecHash: queryContractDigest({ codec: "postgres-wire-v2-ascii-identity", policy }),
    interpreterHash: queryContractDigest({
      adapter: postgresContractAdapterVersion,
      analysis: "postgres-analysis-v2-keywords-ascii",
      vocabulary: POSTGRES_VOCABULARY_REVISION,
    }),
  });
}

export { postgresProjectCatalogOwner } from "./project-catalog-identity.js";
