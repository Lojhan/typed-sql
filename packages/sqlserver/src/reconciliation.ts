import {
  type ContractComparisonDecision,
  type ContractReconciliationContribution,
  canonicalContractData,
} from "@typed-sql/analysis";
import type { RuntimeValueType } from "@typed-sql/core";
import { sqlServerContractPolicy, sqlServerContractReconciliationOwner } from "./contract-profile.js";
import { parseSqlServerNativeType } from "./native-types.js";
import { mapSqlServerType, type SqlServerTypePolicy, sqlServerRuntimeValueType } from "./type-policy.js";
import { SQLSERVER_DIALECT_VERSION } from "./version.js";

const decision = (
  status: ContractComparisonDecision["status"],
  rule: string,
  reason: string,
  staticStatus: ContractComparisonDecision["staticStatus"] = "known",
): ContractComparisonDecision => ({ status, staticStatus, rule, reason });
const representation = (left: RuntimeValueType, right: RuntimeValueType) =>
  (typeof left === "object" &&
    "json" in left &&
    typeof right === "object" &&
    "json" in right &&
    left.json.representation === right.json.representation) ||
  canonicalContractData(left) === canonicalContractData(right);
/** Reconcile successful claims as well as the unqualified-routine metadata gap. */
export function createSqlServerContractReconciler(
  options: { readonly typePolicy?: SqlServerTypePolicy } = {},
): ContractReconciliationContribution {
  const policy = sqlServerContractPolicy(options.typePolicy);
  return Object.freeze<ContractReconciliationContribution>({
    ...sqlServerContractReconciliationOwner,
    grammar: { id: "sqlserver", version: SQLSERVER_DIALECT_VERSION },
    classify(claim) {
      const errors = claim.diagnostics.filter((item) => item.severity === "error");
      return errors.some(({ code }) => code !== "TSQ105" && code !== "TSQ408")
        ? {
            status: "invalid",
            rule: "static-errors-remain-blocking",
            reason: "Schema, arity, version and unsupported-syntax diagnostics remain blocking",
          }
        : errors.length
          ? {
              status: "unsupported",
              rule: "native-routine-result-evidence",
              reason: "Qualified native acceptance may supply the unqualified builtin routine metadata gap",
            }
          : {
              status: "resolved",
              rule: "independent-static-analysis",
              reason: "Compare every available successful static claim",
            };
    },
    compare({ facet, expected, native }) {
      if (facet === "nullability") {
        if (native.nullable.status === "unknown" || native.nullable.precision === "upper-bound")
          return decision(
            "widened",
            "native-nullable-bound",
            "Unknown or conservative native nullability remains nullable",
          );
        return decision(
          native.nullable.value && !expected.nullable ? "conflict" : "compatible",
          "native-nullability-exact",
          "Compare exact native nullability independently",
        );
      }
      const expectedNative = expected.databaseType ? parseSqlServerNativeType(expected.databaseType) : undefined;
      if (facet === "runtime-type") {
        const declared = sqlServerRuntimeValueType(expected, policy);
        if (expectedNative) {
          const mapped = sqlServerRuntimeValueType(
            {
              tsType: mapSqlServerType(expectedNative.text, policy),
              databaseType: expectedNative.text,
              nullable: true,
            },
            policy,
          );
          if (mapped !== "unknown" && declared !== "unknown" && !representation(mapped, declared))
            return decision(
              "conflict",
              "static-codec-policy-conflict",
              "Static application representation contradicts its native type and selected policy",
            );
        }
        if (expected.runtimeType && declared !== "unknown" && !representation(expected.runtimeType, declared))
          return decision(
            "conflict",
            "static-runtime-descriptor-conflict",
            "Static runtime metadata contradicts its declared application representation",
          );
        const type = expected.runtimeType ?? declared;
        if (type === "unknown" || type === "never")
          return decision(
            "unavailable",
            "static-runtime-unavailable",
            "No qualified static representation is available",
            expected.tsType === "unknown" ? "unknown" : "known",
          );
        if (native.runtimeType.status === "unknown")
          return decision(
            "widened",
            "native-runtime-unavailable",
            "Publish unknown instead of an unverified static representation",
          );
        const json = typeof native.runtimeType.value === "object" && "json" in native.runtimeType.value;
        return decision(
          representation(type, native.runtimeType.value) ? (json ? "widened" : "compatible") : "conflict",
          "runtime-representation-equality",
          "Compare policy-controlled representations; retain the native bound for JSON shape",
        );
      }
      if (!expectedNative)
        return decision(
          "unavailable",
          "static-identity-unavailable",
          "No qualified static native identity is available",
          "unknown",
        );
      const status = expected.databaseTypeIsPartial ? "partial" : "known";
      if (native.nativeType.status === "unknown")
        return decision("widened", "native-identity-unavailable", "Native identity is unavailable", status);
      const actual = parseSqlServerNativeType(native.nativeType.value.name);
      if (!actual)
        return decision(
          "unavailable",
          "native-identity-unsupported",
          "The installed owner cannot compare this native identity",
          status,
        );
      if (status === "partial")
        return decision(
          expectedNative.name === actual.name ? "widened" : "conflict",
          "native-family-bound",
          "A partial static claim cannot establish dimensions or collation",
          status,
        );
      const same = (expectedNative.baseText ?? expectedNative.text) === (actual.baseText ?? actual.text);
      const collation =
        !expectedNative.collation ||
        !actual.collation ||
        expectedNative.collation.toLowerCase() === actual.collation.toLowerCase();
      return decision(
        !same || !collation ? "conflict" : native.nativeType.value.complete ? "compatible" : "widened",
        "native-system-type-equality",
        "Preserve dimensions and explicit collation while retaining incomplete native identity",
        status,
      );
    },
  });
}
