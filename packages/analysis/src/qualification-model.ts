import { canonicalContractData, queryContractDigest } from "./canonical.js";
import {
  type NativeContractValueEvidence,
  type NativeQueryContractEvidence,
  nativeContractParametersAvailable,
} from "./native-evidence.js";

export type ContractValueFacet = "native-type" | "runtime-type" | "nullability";
export interface ContractQualificationPolicy {
  readonly mode: "hybrid" | "native-required";
  readonly owner: { readonly id: string; readonly version: string };
  readonly requiredNativeFacets: readonly ContractValueFacet[];
}
export interface ContractFacetComparison {
  readonly target: "query" | "column" | "parameter";
  readonly index: number;
  readonly facet: ContractValueFacet | "acceptance" | "result-shape" | "result-kind";
  readonly staticStatus: "known" | "partial" | "unknown";
  readonly nativeStatus: "complete" | "partial" | "unknown";
  readonly status: "compatible" | "widened" | "conflict" | "unavailable";
  readonly rule: string;
  readonly reason: string;
}
export interface QueryContractQualification {
  readonly policy: ContractQualificationPolicy;
  readonly policyHash: string;
  readonly staticClaimHash: string;
  readonly nativeEvidenceHash: string;
  readonly sourceContractHash: string;
  readonly comparisons: readonly ContractFacetComparison[];
}
export const contractValueFacets: readonly ContractValueFacet[] = ["native-type", "runtime-type", "nullability"];
const hashes = /^[a-f0-9]{64}$/u;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid qualification object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((name) => !Object.hasOwn(value, name)))
    throw new TypeError("Invalid qualification fields");
}
function text(value: unknown): void {
  if (typeof value !== "string" || !value.length || value.length > 16_384)
    throw new TypeError("Invalid qualification text");
}
export function parseContractQualificationPolicy(input: unknown): ContractQualificationPolicy {
  const value = object(JSON.parse(canonicalContractData(input)));
  fields(value, ["mode", "owner", "requiredNativeFacets"]);
  const owner = object(value.owner);
  fields(owner, ["id", "version"]);
  text(owner.id);
  text(owner.version);
  if (
    !["hybrid", "native-required"].includes(value.mode as string) ||
    !Array.isArray(value.requiredNativeFacets) ||
    value.requiredNativeFacets.some(
      (facet, index, items) => !contractValueFacets.includes(facet) || items.indexOf(facet) !== index,
    )
  )
    throw new TypeError("Invalid qualification policy");
  return Object.freeze({
    mode: value.mode,
    owner: Object.freeze(owner),
    requiredNativeFacets: Object.freeze([...value.requiredNativeFacets].sort()),
  }) as unknown as ContractQualificationPolicy;
}
export function contractNativeFacetStatus(
  value: NativeContractValueEvidence,
  facet: ContractValueFacet,
): ContractFacetComparison["nativeStatus"] {
  if (facet === "native-type")
    return value.nativeType.status === "known" ? (value.nativeType.value.complete ? "complete" : "partial") : "unknown";
  if (facet === "runtime-type")
    return value.runtimeType.status === "known" &&
      value.runtimeType.value !== "unknown" &&
      value.runtimeType.value !== "never"
      ? "complete"
      : "unknown";
  return value.nullable.status === "known"
    ? value.nullable.precision === "exact" || !value.nullable.value
      ? "complete"
      : "partial"
    : "unknown";
}
/** Validated successful proofs only. Failure reports are never accepted as compiler qualification. */
export function parseQueryContractQualification(
  input: unknown,
  evidence: NativeQueryContractEvidence,
): QueryContractQualification {
  if (!nativeContractParametersAvailable(evidence))
    throw new TypeError("Qualification parameter binding is unavailable");
  const value = object(JSON.parse(canonicalContractData(input)));
  fields(value, ["policy", "policyHash", "staticClaimHash", "nativeEvidenceHash", "sourceContractHash", "comparisons"]);
  const policy = parseContractQualificationPolicy(value.policy);
  for (const name of ["policyHash", "staticClaimHash", "nativeEvidenceHash", "sourceContractHash"])
    if (typeof value[name] !== "string" || !hashes.test(value[name] as string))
      throw new TypeError("Invalid qualification hash");
  if (queryContractDigest(policy) !== value.policyHash || queryContractDigest(evidence) !== value.nativeEvidenceHash)
    throw new TypeError("Qualification policy or evidence hash differs");
  if (!Array.isArray(value.comparisons)) throw new TypeError("Invalid qualification comparisons");
  const seen = new Set<string>();
  for (const input of value.comparisons) {
    const item = object(input);
    fields(item, ["target", "index", "facet", "staticStatus", "nativeStatus", "status", "rule", "reason"]);
    text(item.rule);
    text(item.reason);
    if (
      !["query", "column", "parameter"].includes(item.target as string) ||
      !Number.isSafeInteger(item.index) ||
      !["known", "partial", "unknown"].includes(item.staticStatus as string) ||
      !["complete", "partial", "unknown"].includes(item.nativeStatus as string) ||
      !["compatible", "widened", "unavailable"].includes(item.status as string)
    )
      throw new TypeError("Invalid successful qualification comparison");
    const key = `${item.target}:${item.index}:${item.facet}`;
    if (seen.has(key)) throw new TypeError("Duplicate qualification comparison");
    seen.add(key);
    if (item.target === "query") {
      if (
        item.index !== 0 ||
        !["acceptance", "result-shape", "result-kind"].includes(item.facet as string) ||
        item.nativeStatus !== "complete"
      )
        throw new TypeError("Invalid query qualification facet");
    } else {
      const descriptors = item.target === "column" ? evidence.columns : evidence.parameters;
      if (
        (item.index as number) < 1 ||
        (item.index as number) > descriptors.length ||
        !contractValueFacets.includes(item.facet as ContractValueFacet)
      )
        throw new TypeError("Invalid value qualification facet");
      const native = contractNativeFacetStatus(
        descriptors[(item.index as number) - 1]!,
        item.facet as ContractValueFacet,
      );
      if (
        item.nativeStatus !== native ||
        (policy.requiredNativeFacets.includes(item.facet as ContractValueFacet) && native !== "complete")
      )
        throw new TypeError("Required native qualification facet unavailable");
    }
    if (item.status === "unavailable" && item.staticStatus !== "unknown")
      throw new TypeError("Known static claim has unverified compatibility");
    if (item.status === "compatible" && item.nativeStatus === "unknown")
      throw new TypeError("Unknown native fact cannot certify agreement");
    Object.freeze(item);
  }
  const count = 3 + 3 * (evidence.columns.length + evidence.parameters.length);
  if (
    seen.size !== count ||
    ["acceptance", "result-shape", "result-kind"].some((facet) => !seen.has(`query:0:${facet}`))
  )
    throw new TypeError("Incomplete qualification comparison closure");
  return Object.freeze({
    ...value,
    policy,
    comparisons: Object.freeze(value.comparisons),
  }) as unknown as QueryContractQualification;
}
