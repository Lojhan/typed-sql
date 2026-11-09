import { type ContractInterpreterIdentity, canonicalContractData, queryContractDigest } from "@typed-sql/analysis";
import { defaultSqliteTypePolicy, type SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_VOCABULARY_REVISION } from "./vocabulary-identity.js";

export const sqliteContractAdapterVersion = "node-sqlite-readonly-prepare-v1";
export const sqliteContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/sqlite/reconciliation",
  version: "sqlite-storage-domain-reconciliation-v3",
});
/** Validate the policy before transferring data into an owned native worker. */
export function sqliteContractPolicy(input: SqliteTypePolicy = defaultSqliteTypePolicy): SqliteTypePolicy {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      (value.json === undefined ? "flexible,integer,unknown" : "flexible,integer,json,unknown") ||
    !["bigint", "number"].includes(value.integer) ||
    !["union", "unknown"].includes(value.flexible) ||
    !["unknown", "never"].includes(value.unknown) ||
    (value.json !== undefined && !["string", "parsed"].includes(value.json))
  )
    throw new TypeError("Invalid SQLite contract type policy");
  return Object.freeze(value);
}
/** Lightweight compatibility identities; no driver or analyzer is imported. */
export function sqliteContractIdentity(
  policy: SqliteTypePolicy = defaultSqliteTypePolicy,
): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "sqlite-owned-readonly-select-v1" }),
    codecHash: queryContractDigest({ codec: "sqlite-storage-domain-v1", policy: sqliteContractPolicy(policy) }),
    interpreterHash: queryContractDigest({
      adapter: sqliteContractAdapterVersion,
      analysis: "sqlite-analysis-keywords-v2",
      vocabulary: SQLITE_VOCABULARY_REVISION,
    }),
  });
}
