import type {
  ContractComparisonDecision,
  ContractReconciliationContribution,
  NativeContractValueEvidence,
  StaticContractField,
} from "@typed-sql/analysis";
import { canonicalContractData } from "@typed-sql/analysis";
import { postgresCatalogType } from "./catalog/index.js";
import type { PostgresProfileSnapshot } from "./profile.js";
import { postgresRuntimeValueType } from "./query.js";
import { defaultPostgresTypePolicy, type PostgresTypePolicy } from "./type-policy.js";
import { POSTGRES_DIALECT_VERSION } from "./version.js";

const result = (
  status: ContractComparisonDecision["status"],
  staticStatus: ContractComparisonDecision["staticStatus"],
  rule: string,
  reason: string,
): ContractComparisonDecision => ({ status, staticStatus, rule, reason });
function nullability(expected: StaticContractField, native: NativeContractValueEvidence): ContractComparisonDecision {
  if (native.nullable.status === "unknown")
    return result(
      "widened",
      "known",
      "native-nullability-conservative",
      "Native nullability is unknown; the published contract includes NULL instead of retaining an unverified non-null refinement",
    );
  if (native.nullable.value && !expected.nullable)
    return native.nullable.precision === "upper-bound"
      ? result(
          "widened",
          "known",
          "nullable-upper-bound",
          "A native nullable upper bound does not disprove a static refinement; publish the conservative bound",
        )
      : result(
          "conflict",
          "known",
          "native-nullability-conflict",
          "Exact native nullability contradicts the static non-null claim",
        );
  return result(
    "compatible",
    "known",
    "nullability-bound-compatible",
    "Native nullability is compatible with the static bound",
  );
}
/** Pure grammar-owned reconciliation. It neither opens a database nor loads into a lightweight profile. */
export function createPostgresContractReconciler(
  options: { readonly schema?: PostgresProfileSnapshot; readonly typePolicy?: PostgresTypePolicy } = {},
): ContractReconciliationContribution {
  const policy = Object.freeze({ ...(options.typePolicy ?? defaultPostgresTypePolicy) });
  return Object.freeze({
    id: "@typed-sql/postgres/reconciliation",
    version: "postgres-contract-reconciliation-v1",
    grammar: { id: "postgres", version: POSTGRES_DIALECT_VERSION },
    classify(claim) {
      return claim.diagnostics.some((item) => item.severity === "error")
        ? {
            status: "invalid",
            rule: "static-errors-remain-blocking",
            reason: "This owner has not qualified an unsupported-production exception for these diagnostics",
          }
        : {
            status: "resolved",
            rule: "independent-static-analysis",
            reason: "Compare all available static facets, including results with no diagnostics",
          };
    },
    compare({ facet, expected, native, target }) {
      if (facet === "nullability") return nullability(expected, native);
      if (facet === "runtime-type") {
        const declared = postgresRuntimeValueType(expected, policy);
        if (
          expected.runtimeType !== undefined &&
          declared !== "unknown" &&
          declared !== "never" &&
          canonicalContractData(declared) !== canonicalContractData(expected.runtimeType)
        )
          return result(
            "conflict",
            "known",
            "static-type-codec-conflict",
            "The static application type and its runtime descriptor disagree under the selected policy",
          );
        if (declared === "unknown" && expected.tsType !== "unknown")
          return result(
            "unavailable",
            "known",
            "static-application-type-unqualified",
            "The static application type requires a qualified runtime interpretation before comparison",
          );
        const type = expected.runtimeType ?? declared;
        if (type === "unknown" || type === "never")
          return result(
            "unavailable",
            "unknown",
            "native-fills-static-representation",
            "The offline analyzer has no qualified runtime representation",
          );
        if (native.runtimeType.status === "unknown")
          return result(
            "widened",
            "known",
            "native-representation-conservative",
            "Native representation is unavailable; the contract publishes unknown instead of an unverified static type",
          );
        if (canonicalContractData(type) === canonicalContractData(native.runtimeType.value))
          return result(
            "compatible",
            "known",
            "runtime-descriptor-equality",
            "Both producers establish the same runtime descriptor",
          );
        if (typeof type === "string" && typeof native.runtimeType.value === "string")
          return result(
            "conflict",
            "known",
            "runtime-representation-conflict",
            "Static and native runtime representations differ under the same decoding policy",
          );
        return result(
          "unavailable",
          "known",
          "runtime-refinement-unqualified",
          "Structural or literal refinements require an explicitly qualified comparison rule",
        );
      }
      const expectedType = expected.databaseType;
      if (expectedType === undefined)
        return result(
          "unavailable",
          "unknown",
          "native-fills-static-identity",
          "No static database identity is available",
        );
      const staticStatus = expected.databaseTypeIsPartial ? "partial" : "known";
      if (native.nativeType.status === "unknown")
        return result(
          "widened",
          staticStatus,
          "native-identity-unavailable",
          "The native contract does not retain an unverified static database identity",
        );
      const actual = native.nativeType.value;
      if (expectedType === actual.name)
        return result(
          "compatible",
          staticStatus,
          "database-identity-text-equality",
          "Both producers name the same database identity in the captured context",
        );
      if (expectedType.trim().endsWith("[]") !== actual.name.trim().endsWith("[]"))
        return result(
          "conflict",
          staticStatus,
          "database-container-family-conflict",
          "Array and scalar database identities differ",
        );
      const left = postgresCatalogType(expectedType, options.schema),
        right = postgresCatalogType(actual.name, options.schema);
      if (!left || !right)
        return result(
          "unavailable",
          staticStatus,
          "opaque-identity-comparison-unavailable",
          "Opaque or custom identities need their contribution's comparison rule",
        );
      if (left.name !== right.name) {
        if (left.mapping === right.mapping && /\(/u.test(expectedType))
          return result(
            "unavailable",
            staticStatus,
            "modifier-dependent-alias-unqualified",
            "A modifier-dependent declaration needs a qualified canonical identity rule",
          );
        return result(
          "conflict",
          staticStatus,
          "database-family-conflict",
          "Qualified built-in database type families differ",
        );
      }
      if (expected.databaseTypeIsPartial || (target === "parameter" && !actual.complete))
        return result(
          "compatible",
          "partial",
          "database-family-only",
          "Known families agree; unavailable modifiers are not certified",
        );
      const modifiers = (type: string) => /\([^)]*\)/u.exec(type)?.[0].replaceAll(/\s/gu, "") ?? "";
      return modifiers(expectedType) === modifiers(actual.name)
        ? result(
            "compatible",
            staticStatus,
            "builtin-alias-equivalence",
            "Pinned built-in aliases and declared modifiers agree",
          )
        : result(
            "unavailable",
            staticStatus,
            "database-modifier-comparison-unavailable",
            "Modifier compatibility is not established by family equality",
          );
    },
  } satisfies ContractReconciliationContribution);
}
