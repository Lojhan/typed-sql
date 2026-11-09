import {
  type ContractComparisonDecision,
  type ContractReconciliationContribution,
  canonicalContractData,
} from "@typed-sql/analysis";
import { duckDBContractReconciliationOwner } from "./contract-profile.js";
import { formatDuckDBType, parseDuckDBType } from "./native-types.js";
import {
  type DuckDBTypePolicy,
  defaultDuckDBTypePolicy,
  duckDBRuntimeValueType,
  duckDBTypeScript,
  isKnownDuckDBType,
  validateDuckDBTypePolicy,
} from "./type-policy.js";
import { DUCKDB_DIALECT_VERSION } from "./version.js";

const decision = (
  status: ContractComparisonDecision["status"],
  staticStatus: ContractComparisonDecision["staticStatus"],
  rule: string,
  reason: string,
): ContractComparisonDecision => ({ status, staticStatus, rule, reason });

/** Compare independent offline claims with native metadata under the same decoding policy. */
export function createDuckDBContractReconciler(
  options: { readonly typePolicy?: DuckDBTypePolicy } = {},
): ContractReconciliationContribution {
  const policy = validateDuckDBTypePolicy(options.typePolicy ?? defaultDuckDBTypePolicy);
  return Object.freeze<ContractReconciliationContribution>({
    ...duckDBContractReconciliationOwner,
    grammar: { id: "duckdb", version: DUCKDB_DIALECT_VERSION },
    classify(claim) {
      const errors = claim.diagnostics.filter((item) => item.severity === "error");
      return errors.some((item) => item.code !== "TSQ408")
        ? {
            status: "invalid",
            rule: "static-errors-remain-blocking",
            reason: "Invalid, unsafe and unsupported syntax diagnostics remain blocking",
          }
        : errors.length
          ? {
              status: "unsupported",
              rule: "routine-result-requires-native-evidence",
              reason: "Only the routine-result metadata gap may be supplied by qualified native preparation",
            }
          : {
              status: "resolved",
              rule: "independent-static-analysis",
              reason: "Compare every available static claim, including successful offline inference",
            };
    },
    compare({ facet, expected, native }) {
      if (facet === "nullability") {
        if (
          native.nullable.status === "unknown" ||
          (native.nullable.precision === "upper-bound" && native.nullable.value)
        )
          return decision(
            "widened",
            "known",
            "native-nullability-conservative",
            "Publish the nullable native bound without an unverified offline non-null refinement",
          );
        return decision(
          native.nullable.value && !expected.nullable ? "conflict" : "compatible",
          "known",
          "native-nullability-exact",
          "Compare exact native nullability with the static bound",
        );
      }
      if (facet === "runtime-type") {
        const declared = duckDBRuntimeValueType(expected, policy);
        if (
          expected.databaseType &&
          declared !== "unknown" &&
          expected.tsType !== "unknown" &&
          expected.tsType !== duckDBTypeScript(parseDuckDBType(expected.databaseType), policy)
        )
          return decision(
            "conflict",
            "known",
            "static-application-type-codec-conflict",
            "The static application type disagrees with its native type under the selected policy",
          );
        if (
          expected.runtimeType !== undefined &&
          declared !== "unknown" &&
          canonicalContractData(declared) !== canonicalContractData(expected.runtimeType)
        )
          return decision(
            "conflict",
            "known",
            "static-type-codec-conflict",
            "Static runtime metadata disagrees with its declared database type and policy",
          );
        const type = expected.runtimeType ?? declared;
        if (type === "unknown" || type === "never")
          return decision(
            "unavailable",
            expected.tsType === "unknown" || expected.tsType === "never" ? "unknown" : "known",
            "static-representation-unavailable",
            "No qualified static runtime representation is available",
          );
        if (native.runtimeType.status === "unknown")
          return decision(
            "widened",
            "known",
            "native-representation-unavailable",
            "Publish unknown when native representation is unavailable",
          );
        return decision(
          canonicalContractData(type) === canonicalContractData(native.runtimeType.value) ? "compatible" : "conflict",
          "known",
          "runtime-descriptor-equality",
          "Both producers must establish the same runtime descriptor under the selected policy",
        );
      }
      if (!expected.databaseType || !isKnownDuckDBType(parseDuckDBType(expected.databaseType)))
        return decision(
          "unavailable",
          "unknown",
          "static-identity-unavailable",
          "No qualified static native type identity is available",
        );
      const status = expected.databaseTypeIsPartial ? "partial" : "known";
      if (native.nativeType.status === "unknown")
        return decision(
          "widened",
          status,
          "native-identity-unavailable",
          "Publish unknown rather than an unverified static native identity",
        );
      return decision(
        formatDuckDBType(parseDuckDBType(expected.databaseType)) === native.nativeType.value.name
          ? "compatible"
          : "conflict",
        status,
        "native-logical-type-equality",
        "Compare canonical native logical types, including decimal dimensions and nested shapes",
      );
    },
  });
}
