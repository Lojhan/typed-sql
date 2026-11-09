import { type ContractInterpreterIdentity, canonicalContractData, queryContractDigest } from "@typed-sql/analysis";
import { defaultSqlServerTypePolicy, type SqlServerTypePolicy, validateSqlServerTypePolicy } from "./type-policy.js";
import { SQLSERVER_VOCABULARY_REVISION } from "./vocabulary-identity.js";

export const sqlServerContractAdapterVersion = "sqlserver-log-guarded-describe-v4";
export const sqlServerContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/sqlserver/reconciliation",
  version: "sqlserver-contract-reconciliation-v3",
});
export function sqlServerContractPolicy(input: SqlServerTypePolicy = defaultSqlServerTypePolicy): SqlServerTypePolicy {
  const value = JSON.parse(canonicalContractData(input));
  if (!value || Object.keys(value).sort().join() !== "bigint,decimal,json,temporal,unknown")
    throw new TypeError("Invalid SQL Server contract type policy");
  return validateSqlServerTypePolicy(value);
}
/** Pure compatibility identity, without an analyzer or a native client. */
export function sqlServerContractIdentity(
  policy: SqlServerTypePolicy = defaultSqlServerTypePolicy,
): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "sqlserver-guarded-select-profile-v2" }),
    codecHash: queryContractDigest({
      codec: "sqlserver-native-descriptor-v1",
      policy: sqlServerContractPolicy(policy),
    }),
    interpreterHash: queryContractDigest({
      adapter: sqlServerContractAdapterVersion,
      vocabulary: SQLSERVER_VOCABULARY_REVISION,
    }),
  });
}
