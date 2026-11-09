import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { canonicalContractData, exactSqlDigest, queryContractDigest } from "./canonical.js";
import {
  parseQueryContract,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
} from "./contracts.js";
import { type ContractQualificationPolicy, parseContractQualificationPolicy } from "./qualification-model.js";

/** Exact recorded-context lookup, available before any semantic owner is loaded. */
export interface RecordedAnalysisQuery {
  readonly connectionContext: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly candidate: NativeContractCandidate;
  readonly context: QueryContractContext;
  readonly policy: ContractQualificationPolicy;
}

export function parseRecordedAnalysisQuery(input: RecordedAnalysisQuery): RecordedAnalysisQuery {
  const value = JSON.parse(canonicalContractData(input));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "adapter,candidate,connectionContext,context,policy" ||
    typeof value.connectionContext !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.connectionContext) ||
    !value.adapter ||
    typeof value.adapter !== "object" ||
    Array.isArray(value.adapter) ||
    Object.keys(value.adapter).sort().join(",") !== "id,version" ||
    Object.values(value.adapter).some((item) => typeof item !== "string" || !item.length || item.length > 4096)
  )
    throw new TypeError("Invalid recorded analysis query");
  return Object.freeze({
    ...value,
    adapter: Object.freeze(value.adapter),
    candidate: parseNativeContractCandidate(value.candidate),
    context: parseQueryContractContext(value.context),
    policy: parseContractQualificationPolicy(value.policy),
  });
}

export function recordedAnalysisQueryKey(query: RecordedAnalysisQuery): string {
  return queryContractDigest({ lookup: "recorded-analysis-v1", query });
}

/** A hit proves compatibility with recorded inputs, never current database freshness. */
export function parseRecordedQueryContract(input: QueryContract, expected: RecordedAnalysisQuery): QueryContract {
  const contract = parseQueryContract(input);
  if (
    contract.sqlDigest !== exactSqlDigest(expected.candidate.sql) ||
    canonicalContractData(contract.context) !== canonicalContractData(expected.context) ||
    contract.qualification?.policyHash !== queryContractDigest(expected.policy) ||
    contract.nativeEvidence?.adapter.id !== expected.adapter.id ||
    contract.nativeEvidence.adapter.version !== expected.adapter.version ||
    canonicalContractData(contract.nativeEvidence.parameterOccurrences) !==
      canonicalContractData(expected.candidate.parameterOccurrences) ||
    (expected.candidate.columnSpans !== undefined &&
      canonicalContractData(contract.columnSpans) !== canonicalContractData(expected.candidate.columnSpans))
  )
    throw new TypeError("Recorded contract does not match the requested qualification");
  return contract;
}
