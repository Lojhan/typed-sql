import {
  type ContractComparisonDecision,
  type ContractReconciliationContribution,
  canonicalContractData,
} from "@typed-sql/analysis";
import { mySqlContractReconciliationOwner, validateMySqlContractPolicy } from "./contract-profile.js";
import { mysqlRuntimeValueType } from "./query.js";
import {
  defaultMySqlTypePolicy,
  isKnownMySqlType,
  type MySqlTypePolicy,
  mapMySqlType,
  mySqlTypeDeclaration,
} from "./type-policy.js";
import { MYSQL_DIALECT_VERSION } from "./version.js";

const decision = (
  status: ContractComparisonDecision["status"],
  staticStatus: ContractComparisonDecision["staticStatus"],
  rule: string,
  reason: string,
): ContractComparisonDecision => ({ status, staticStatus, rule, reason });
const identity = (name: string) =>
  mySqlTypeDeclaration(name)
    .replace(/^integer\b/u, "int")
    .replace(/^double precision\b/u, "double")
    .replace(/^real\b/u, "double")
    .replace(/^(?:decimal|numeric|dec|fixed)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/u, "decimal($1,$2)");
const family = (name: string) => {
  const base = identity(name)
    .split("(")[0]!
    .replace(/\s+(?:unsigned|signed|zerofill)$/u, "")
    .trim();
  if (["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"].includes(base)) return "text";
  if (["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"].includes(base)) return "binary";
  if (
    [
      "geometry",
      "point",
      "linestring",
      "polygon",
      "multipoint",
      "multilinestring",
      "multipolygon",
      "geometrycollection",
    ].includes(base)
  )
    return "geometry";
  return base;
};
const decimal = (name: string) => /^(?:decimal|numeric|dec|fixed)\((\d+),(\d+)\)(?: unsigned)?$/u.exec(name);
/** Compare independent descriptions; a wire-family identity never proves missing dimensions. */
export function createMySqlContractReconciler(
  options: { readonly typePolicy?: MySqlTypePolicy } = {},
): ContractReconciliationContribution {
  const policy = validateMySqlContractPolicy(options.typePolicy ?? defaultMySqlTypePolicy);
  return Object.freeze<ContractReconciliationContribution>({
    ...mySqlContractReconciliationOwner,
    grammar: { id: "mysql", version: MYSQL_DIALECT_VERSION },
    classify(claim) {
      return claim.diagnostics.some((item) => item.severity === "error")
        ? {
            status: "invalid",
            rule: "static-errors-remain-blocking",
            reason: "Invalid SQL and unsupported syntax remain blocking",
          }
        : {
            status: "resolved",
            rule: "independent-static-analysis",
            reason: "Compare every available static claim, including successful offline inference",
          };
    },
    compare({ facet, expected, native, target }) {
      if (facet === "nullability") {
        if (native.nullable.status === "unknown" || native.nullable.precision === "upper-bound")
          return decision(
            "widened",
            "known",
            "native-nullability-conservative",
            "Publish a nullable bound when native nullability is unavailable",
          );
        return decision(
          native.nullable.value && !expected.nullable ? "conflict" : "compatible",
          "known",
          "native-nullability-exact",
          "Compare the native nullability bound independently",
        );
      }
      if (facet === "runtime-type") {
        if (
          expected.databaseType &&
          isKnownMySqlType(expected.databaseType) &&
          expected.tsType !== "unknown" &&
          expected.tsType !== mapMySqlType(expected.databaseType, policy)
        )
          return decision(
            "conflict",
            "known",
            "static-application-type-codec-conflict",
            "Static application type differs from its declared native type under the selected policy",
          );
        const declared = mysqlRuntimeValueType(expected, policy);
        if (
          expected.runtimeType &&
          declared !== "unknown" &&
          canonicalContractData(declared) !== canonicalContractData(expected.runtimeType)
        )
          return decision(
            "conflict",
            "known",
            "static-type-codec-conflict",
            "Static runtime metadata contradicts the selected type policy",
          );
        const type = expected.runtimeType ?? declared;
        if (type === "unknown" || type === "never")
          return decision(
            "unavailable",
            expected.tsType === "unknown" ? "unknown" : "known",
            "static-representation-unavailable",
            "No qualified static runtime representation is available",
          );
        if (native.runtimeType.status === "unknown")
          return decision(
            "widened",
            "known",
            "native-representation-unavailable",
            "Unknown native representation remains unknown",
          );
        return decision(
          canonicalContractData(type) === canonicalContractData(native.runtimeType.value) ? "compatible" : "conflict",
          "known",
          "runtime-descriptor-equality",
          "Both producers must establish the same policy-controlled runtime descriptor",
        );
      }
      if (!expected.databaseType)
        return decision(
          "unavailable",
          "unknown",
          "static-identity-unavailable",
          "No complete static native identity is available",
        );
      const status =
        expected.databaseTypeIsPartial || /^(?:decimal|numeric|dec|fixed)$/iu.test(expected.databaseType)
          ? "partial"
          : "known";
      if (native.nativeType.status === "unknown")
        return decision("widened", status, "native-identity-unavailable", "Native identity is unavailable");
      if (!native.nativeType.value.complete || status === "partial")
        return decision(
          family(expected.databaseType) === family(native.nativeType.value.name) ? "widened" : "conflict",
          status,
          "native-family-bound",
          "Publish the native family and its established dimensions; discard unverified static refinements",
        );
      const a = identity(expected.databaseType),
        b = identity(native.nativeType.value.name);
      if (target === "column" && a === "int" && b === "bigint" && native.descriptor.integerLiteralBound === "int")
        return decision(
          "compatible",
          "known",
          "qualified-integer-literal",
          "The exact SQL literal independently proves the signed INT bound despite BIGINT wire transport",
        );
      if (target === "parameter") {
        const x = decimal(a),
          y = decimal(b);
        if (
          x &&
          y &&
          Number(x[2]) <= Number(y[2]) &&
          Number(x[1]) - Number(x[2]) <= Number(y[1]) - Number(y[2]) &&
          a.endsWith(" unsigned") === b.endsWith(" unsigned")
        )
          return decision(
            "compatible",
            "known",
            "native-input-decimal-bound",
            "The enforced decimal declaration fits the independent native input bound",
          );
      }
      return decision(
        a === b ? "compatible" : "conflict",
        "known",
        "native-declaration-equality",
        "Compare complete native declarations independently",
      );
    },
  });
}
