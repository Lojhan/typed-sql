import { type ContractInterpreterIdentity, queryContractDigest } from "@typed-sql/analysis";
import { defaultMySqlTypePolicy, type MySqlTypePolicy } from "./type-policy.js";

export const mySqlContractAdapterVersion = "mysql-backup-locked-prepare-v2";
export const mySqlContractReconciliationOwner = Object.freeze({
  id: "@typed-sql/mysql/reconciliation",
  version: "mysql-contract-reconciliation-v1",
});
export function validateMySqlContractPolicy(policy: MySqlTypePolicy): MySqlTypePolicy {
  const choices = {
    bigint: ["bigint", "string", "number"],
    decimal: ["string", "number", "Decimal"],
    date: ["Date", "string"],
    json: ["unknown", "JsonValue", "string"],
    tinyint1: ["boolean", "number"],
    unknown: ["unknown", "never"],
  };
  if (Object.keys(policy).sort().join() !== Object.keys(choices).sort().join())
    throw new TypeError("Invalid MySQL contract type policy");
  for (const [key, values] of Object.entries(choices))
    if (!values.includes(policy[key as keyof MySqlTypePolicy]))
      throw new TypeError("Invalid MySQL contract type policy");
  return Object.freeze({ ...policy });
}
/** Pure compatibility identity; importing this entrypoint never loads the optional driver. */
export function mySqlContractIdentity(policy: MySqlTypePolicy = defaultMySqlTypePolicy): ContractInterpreterIdentity {
  return Object.freeze({
    profileHash: queryContractDigest({ profile: "mysql-owned-guarded-select-profile-v2" }),
    codecHash: queryContractDigest({ codec: "mysql-prepare-fields-v1", policy: validateMySqlContractPolicy(policy) }),
    interpreterHash: queryContractDigest(mySqlContractAdapterVersion),
  });
}
