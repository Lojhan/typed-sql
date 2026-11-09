import { type DialectAnalysis, defineQueryValuePlan, type ResolvedParameter } from "@typed-sql/core";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import {
  parseQueryContract,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
} from "./contracts.js";
import { type NativeContractValueEvidence, nativeContractParametersAvailable } from "./native-evidence.js";
import {
  type ContractFacetComparison,
  type ContractQualificationPolicy,
  type ContractValueFacet,
  contractNativeFacetStatus,
  contractValueFacets,
  parseContractQualificationPolicy,
  parseQueryContractQualification,
  type QueryContractQualification,
} from "./qualification-model.js";

export type StaticContractField = Pick<
  ResolvedParameter,
  "tsType" | "nullable" | "databaseType" | "databaseTypeIsPartial" | "runtimeType" | "json"
>;
export interface StaticQueryClaim {
  readonly digest: string;
  readonly context: QueryContractContext;
  readonly sqlDigest: string;
  readonly resultKind: "rows" | "command" | "unknown";
  readonly columns: readonly (StaticContractField & { readonly name: string })[];
  readonly parameters: readonly (StaticContractField & { readonly index: number })[];
  readonly diagnostics: readonly { readonly code: string; readonly severity: "error" | "warning" | "info" }[];
}
export interface ContractComparisonDecision {
  readonly staticStatus: ContractFacetComparison["staticStatus"];
  readonly status: ContractFacetComparison["status"];
  readonly rule: string;
  readonly reason: string;
}
export interface ContractReconciliationContribution {
  readonly id: string;
  readonly version: string;
  readonly grammar: QueryContractContext["grammar"];
  classify(claim: StaticQueryClaim): {
    readonly status: "resolved" | "unsupported" | "invalid" | "unsafe";
    readonly rule: string;
    readonly reason: string;
  };
  compare(input: {
    readonly target: "column" | "parameter";
    readonly index: number;
    readonly facet: ContractValueFacet;
    readonly expected: StaticContractField;
    readonly native: NativeContractValueEvidence;
  }): ContractComparisonDecision;
}
function data(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some((item) => !("value" in item))
  )
    throw new TypeError("Static query claims require plain data");
  return input as Record<string, unknown>;
}
function immutable<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value;
}
function field(input: unknown): StaticContractField {
  const value = data(input);
  if (
    typeof value.tsType !== "string" ||
    !value.tsType.length ||
    value.tsType.length > 16_384 ||
    typeof value.nullable !== "boolean" ||
    (value.databaseTypeIsPartial !== undefined && value.databaseTypeIsPartial !== true)
  )
    throw new TypeError("Invalid static field claim");
  const descriptor = defineQueryValuePlan({
    dialect: "claim",
    typePolicyHash: "claim",
    columns: [
      {
        name: "value",
        type: (value.runtimeType as StaticContractField["runtimeType"]) ?? "unknown",
        nullable: value.nullable,
        ...(value.databaseType === undefined ? {} : { databaseType: value.databaseType as string }),
        ...(value.json === undefined ? {} : { json: value.json as NonNullable<StaticContractField["json"]> }),
      },
    ],
    parameters: [],
  }).columns[0]!;
  return {
    tsType: value.tsType,
    nullable: descriptor.nullable,
    ...(value.runtimeType === undefined ? {} : { runtimeType: descriptor.type }),
    ...(descriptor.databaseType === undefined ? {} : { databaseType: descriptor.databaseType }),
    ...(descriptor.json === undefined ? {} : { json: descriptor.json }),
    ...(value.databaseTypeIsPartial ? { databaseTypeIsPartial: true } : {}),
  };
}
/** Transient compiler claims are data and hashes, never cached executable TypeScript declarations. */
export function createStaticQueryClaim(input: {
  readonly sql: string;
  readonly context: QueryContractContext;
  readonly analysis: DialectAnalysis;
}): StaticQueryClaim {
  data(input.analysis);
  // Canonicalizing arrays first rejects accessor-backed entries without invoking them.
  const arrays = [input.analysis.columns, input.analysis.parameters, input.analysis.diagnostics];
  for (const items of arrays) {
    if (
      !Array.isArray(items) ||
      Object.values(Object.getOwnPropertyDescriptors(items)).some((item) => !("value" in item))
    )
      throw new TypeError("Invalid static claim array");
  }
  const body = {
    context: parseQueryContractContext(input.context),
    sqlDigest: exactSqlDigest(input.sql),
    resultKind: input.analysis.resultKind ?? "unknown",
    columns: input.analysis.columns.map((column) => {
      const value = data(column);
      return { ...field(value), name: value.name };
    }),
    parameters: input.analysis.parameters.map((parameter) => {
      const value = data(parameter);
      return { ...field(value), index: value.index };
    }),
    diagnostics: input.analysis.diagnostics.map((diagnostic) => {
      const value = data(diagnostic);
      return { code: value.code, severity: value.severity };
    }),
  };
  return parseStaticQueryClaim({ ...body, digest: queryContractDigest(body) });
}
export function parseStaticQueryClaim(input: unknown): StaticQueryClaim {
  const value = data(JSON.parse(canonicalContractData(input)));
  if (
    Object.keys(value).sort().join(",") !== "columns,context,diagnostics,digest,parameters,resultKind,sqlDigest" ||
    !["rows", "command", "unknown"].includes(value.resultKind as string) ||
    typeof value.sqlDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sqlDigest) ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.diagnostics)
  )
    throw new TypeError("Invalid static query claim");
  parseQueryContractContext(value.context);
  const columns = value.columns.map((item) => {
    const value = data(item);
    return { ...field(value), name: value.name as string };
  });
  const parameters = value.parameters.map((item) => {
    const value = data(item);
    return { ...field(value), index: value.index as number };
  });
  defineQueryValuePlan({
    dialect: "claim",
    typePolicyHash: "claim",
    columns: columns.map((item) => ({ name: item.name, type: item.runtimeType ?? "unknown", nullable: item.nullable })),
    parameters: parameters.map((item) => ({
      index: item.index,
      type: item.runtimeType ?? "unknown",
      nullable: item.nullable,
    })),
  });
  if (
    canonicalContractData(columns) !== canonicalContractData(value.columns) ||
    canonicalContractData(parameters) !== canonicalContractData(value.parameters)
  )
    throw new TypeError("Noncanonical static field claim");
  for (const input of value.diagnostics) {
    const item = data(input);
    if (
      Object.keys(item).sort().join(",") !== "code,severity" ||
      typeof item.code !== "string" ||
      !item.code.length ||
      !["error", "warning", "info"].includes(item.severity as string)
    )
      throw new TypeError("Invalid static diagnostic claim");
  }
  const { digest, ...body } = value;
  if (queryContractDigest(body) !== digest) throw new TypeError("Static query claim digest differs");
  return immutable(value) as unknown as StaticQueryClaim;
}
function decision(input: unknown): ContractComparisonDecision {
  const value = data(JSON.parse(canonicalContractData(input)));
  if (
    Object.keys(value).sort().join(",") !== "reason,rule,staticStatus,status" ||
    !["known", "partial", "unknown"].includes(value.staticStatus as string) ||
    !["compatible", "widened", "conflict", "unavailable"].includes(value.status as string) ||
    [value.rule, value.reason].some((item) => typeof item !== "string" || !item.length || item.length > 16_384)
  )
    throw new TypeError("Invalid reconciliation decision");
  return value as unknown as ContractComparisonDecision;
}
export type QueryContractReconciliation =
  | { readonly status: "qualified"; readonly contract: QueryContract; readonly report: QueryContractQualification }
  | { readonly status: "conflict" | "incomplete"; readonly report: QueryContractQualification };

/** Independently reconcile available static claims. Conflicts cannot publish a qualified contract. */
export function reconcileQueryContract(input: {
  readonly nativeContract: QueryContract;
  readonly staticClaim: StaticQueryClaim;
  readonly contribution: ContractReconciliationContribution;
  readonly policy: ContractQualificationPolicy;
}): QueryContractReconciliation {
  const native = parseQueryContract(input.nativeContract),
    claim = parseStaticQueryClaim(input.staticClaim),
    policy = parseContractQualificationPolicy(input.policy),
    owner = input.contribution;
  if (!native.nativeEvidence || native.qualification || native.origin !== "native-description")
    throw new TypeError("Reconciliation requires a fresh native contract");
  if (
    claim.sqlDigest !== native.sqlDigest ||
    canonicalContractData(claim.context) !== canonicalContractData(native.context)
  )
    throw new TypeError("Static/native query context differs");
  if (canonicalContractData(owner.grammar) !== canonicalContractData(native.context.grammar))
    throw new TypeError("Reconciliation owner grammar differs");
  if (owner.id !== policy.owner.id || owner.version !== policy.owner.version)
    throw new TypeError("Reconciliation owner policy differs");
  const classification = JSON.parse(canonicalContractData(owner.classify(claim)));
  if (
    !classification ||
    Object.keys(classification).sort().join(",") !== "reason,rule,status" ||
    !["resolved", "unsupported", "invalid", "unsafe"].includes(classification.status) ||
    [classification.reason, classification.rule].some(
      (value) => typeof value !== "string" || !value.length || value.length > 16_384,
    )
  )
    throw new TypeError("Invalid static diagnostic classification");
  if (classification.status === "resolved" && claim.diagnostics.some((item) => item.severity === "error"))
    throw new TypeError("Static errors cannot be classified as resolved");
  const comparisons: ContractFacetComparison[] = [];
  const query = (
    facet: "acceptance" | "result-shape" | "result-kind",
    status: ContractFacetComparison["status"],
    staticStatus: ContractFacetComparison["staticStatus"],
    rule: string,
    reason: string,
  ) =>
    comparisons.push({
      target: "query",
      index: 0,
      facet,
      status,
      staticStatus,
      nativeStatus: "complete",
      rule,
      reason,
    });
  query(
    "acceptance",
    classification.status === "invalid" || classification.status === "unsafe"
      ? "conflict"
      : classification.status === "unsupported"
        ? "unavailable"
        : "compatible",
    classification.status === "unsupported" ? "unknown" : "known",
    classification.rule,
    classification.reason,
  );
  const unavailableShape = classification.status === "unsupported" && !claim.columns.length && !claim.parameters.length;
  const shapeMatches =
    claim.columns.length === native.valuePlan.columns.length &&
    claim.parameters.length === native.valuePlan.parameters.length &&
    claim.columns.every((column, index) => column.name === native.valuePlan.columns[index]?.name);
  query(
    "result-shape",
    unavailableShape ? "unavailable" : shapeMatches ? "compatible" : "conflict",
    unavailableShape ? "unknown" : "known",
    "ordered-result-parameter-shape",
    unavailableShape
      ? "Static production has no qualified shape"
      : "Compare ordered column labels and parameter slot counts",
  );
  query(
    "result-kind",
    claim.resultKind === "unknown"
      ? "unavailable"
      : claim.resultKind === native.nativeEvidence.resultKind
        ? "compatible"
        : "conflict",
    claim.resultKind === "unknown" ? "unknown" : "known",
    "native-result-kind",
    "Statement result kind is independently compared when available",
  );
  for (const target of ["column", "parameter"] as const) {
    const actuals = target === "column" ? native.nativeEvidence.columns : native.nativeEvidence.parameters;
    const expected = target === "column" ? claim.columns : claim.parameters;
    for (const [position, actual] of actuals.entries())
      for (const facet of contractValueFacets) {
        const result = expected[position]
          ? decision(
              owner.compare({ target, index: position + 1, facet, expected: expected[position]!, native: actual }),
            )
          : {
              status: "unavailable" as const,
              staticStatus: "unknown" as const,
              rule: "native-fills-missing-static-facet",
              reason: "No static field claim is available",
            };
        comparisons.push({
          ...result,
          target,
          index: position + 1,
          facet,
          nativeStatus: contractNativeFacetStatus(actual, facet),
        });
      }
  }
  const report: QueryContractQualification = immutable({
    policy,
    policyHash: queryContractDigest(policy),
    staticClaimHash: claim.digest,
    nativeEvidenceHash: queryContractDigest(native.nativeEvidence),
    sourceContractHash: native.digest,
    comparisons,
  });
  if (comparisons.some((item) => item.status === "conflict")) return { status: "conflict", report };
  if (
    !nativeContractParametersAvailable(native.nativeEvidence) ||
    comparisons.some(
      (item) =>
        (item.status === "unavailable" && item.staticStatus !== "unknown") ||
        (item.target !== "query" &&
          policy.requiredNativeFacets.includes(item.facet as ContractValueFacet) &&
          item.nativeStatus !== "complete"),
    )
  )
    return { status: "incomplete", report };
  const qualification = parseQueryContractQualification(report, native.nativeEvidence);
  const { digest: _digest, ...previous } = native;
  const body = { ...previous, origin: "reconciled", qualification };
  const contract = parseQueryContract({ ...body, digest: queryContractDigest(body) });
  return { status: "qualified", contract, report: qualification };
}
