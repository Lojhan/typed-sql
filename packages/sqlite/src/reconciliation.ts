import {
  type ContractComparisonDecision,
  type ContractReconciliationContribution,
  canonicalContractData,
} from "@typed-sql/analysis";
import type { RuntimeValueType } from "@typed-sql/core";
import { sqliteContractPolicy, sqliteContractReconciliationOwner } from "./contract-profile.js";
import { sqliteRuntimeValueType } from "./query.js";
import type { SqliteTypePolicy } from "./type-policy.js";
import { SQLITE_DIALECT_VERSION } from "./version.js";

const compare = (
  status: ContractComparisonDecision["status"],
  rule: string,
  reason: string,
  staticStatus: ContractComparisonDecision["staticStatus"] = "known",
): ContractComparisonDecision => ({ status, staticStatus, rule, reason });
/** Native storage bounds never become sampled expression types or non-null guarantees. */
export function createSqliteContractReconciler(
  options: { readonly typePolicy?: SqliteTypePolicy } = {},
): ContractReconciliationContribution {
  const policy = sqliteContractPolicy(options.typePolicy);
  return Object.freeze<ContractReconciliationContribution>({
    ...sqliteContractReconciliationOwner,
    grammar: { id: "sqlite", version: SQLITE_DIALECT_VERSION },
    classify(claim) {
      const errors = claim.diagnostics.filter(({ severity }) => severity === "error");
      return errors.some(({ code }) => code !== "TSQ402" && code !== "TSQ001" && code !== "TSQ408")
        ? {
            status: "invalid",
            rule: "static-errors-remain-blocking",
            reason: "Static schema, arity and other semantic diagnostics remain blocking",
          }
        : errors.length
          ? {
              status: "unsupported",
              rule: "native-supplies-missing-syntax-or-capability-evidence",
              reason:
                "Owned read-only native preparation can establish exact-statement acceptance when local syntax or capability evidence is unavailable",
            }
          : {
              status: "resolved",
              rule: "independent-static-analysis",
              reason: "Compare every available static claim with native storage-domain evidence",
            };
    },
    compare({ facet, expected, native }) {
      if (facet === "nullability")
        return compare(
          "widened",
          "sqlite-nullability-upper-bound",
          "Preparation does not prove expression nullability; retain the nullable upper bound",
        );
      if (facet === "native-type")
        return compare(
          "widened",
          "sqlite-dynamic-storage-class",
          "Declared source-column types do not establish the result storage class for expressions or compound queries",
          expected.databaseType ? "partial" : "unknown",
        );
      const type = expected.runtimeType ?? sqliteRuntimeValueType(expected, policy);
      if (type === "unknown" || type === "never")
        return compare(
          "widened",
          "native-storage-fills-unknown",
          "Retain the qualified native storage domain for an unresolved static representation",
          "unknown",
        );
      if (native.runtimeType.status === "unknown" || native.runtimeType.value === "unknown")
        return compare(
          "widened",
          "unknown-native-representation",
          "No native runtime representation can refine the selected unknown policy",
        );
      const domain: readonly RuntimeValueType[] =
        typeof native.runtimeType.value === "object" && "union" in native.runtimeType.value
          ? native.runtimeType.value.union
          : [native.runtimeType.value];
      const expectedTypes = typeof type === "object" && "union" in type ? type.union : [type];
      const contained = expectedTypes.every((item) =>
        domain.some((actual) => canonicalContractData(item) === canonicalContractData(actual)),
      );
      return compare(
        contained ? "widened" : "conflict",
        "sqlite-storage-domain-containment",
        "A static representation outside the selected native storage domain conflicts; narrower compatible claims retain the native bound",
      );
    },
  });
}
