import { canonicalContractData, exactSqlDigest } from "./canonical.js";
import type { QueryContract } from "./contracts.js";
import { type NativeQueryContractEvidence, validateNativeParameterOccurrences } from "./native-evidence.js";

export interface NativeContractCandidate {
  readonly sql: string;
  readonly parameterOccurrences: NativeQueryContractEvidence["parameterOccurrences"];
  readonly columnSpans?: QueryContract["columnSpans"];
}
export function parseNativeContractCandidate(input: unknown): NativeContractCandidate {
  const candidate: NativeContractCandidate = JSON.parse(canonicalContractData(input));
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    typeof candidate.sql !== "string" ||
    !candidate.sql.length ||
    Object.keys(candidate).sort().join(",") !==
      (Object.hasOwn(candidate, "columnSpans") ? "columnSpans,parameterOccurrences,sql" : "parameterOccurrences,sql")
  )
    throw new TypeError("Invalid native contract candidate");
  exactSqlDigest(candidate.sql);
  validateNativeParameterOccurrences(candidate.parameterOccurrences, candidate.sql.length);
  if (candidate.columnSpans !== undefined) {
    if (!Array.isArray(candidate.columnSpans)) throw new TypeError("Invalid native candidate column spans");
    for (const span of candidate.columnSpans) {
      if (
        !span ||
        Object.keys(span).sort().join(",") !== "end,start" ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end < span.start ||
        span.end > candidate.sql.length
      )
        throw new TypeError("Invalid native candidate column span");
      Object.freeze(span);
    }
    Object.freeze(candidate.columnSpans);
  }
  for (const occurrence of candidate.parameterOccurrences) Object.freeze(occurrence);
  Object.freeze(candidate.parameterOccurrences);
  Object.freeze(candidate);
  return candidate;
}
