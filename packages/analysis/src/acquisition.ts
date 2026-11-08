import { canonicalContractData, exactSqlDigest } from "./canonical.js";
import {
  createQueryContract,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
} from "./contracts.js";
import {
  type NativeQueryContractEvidence,
  nativeContractParametersAvailable,
  nativeContractValuePlan,
  parseNativeQueryContractEvidence,
  validateNativeParameterOccurrences,
} from "./native-evidence.js";

export interface NativeContractCandidate {
  readonly sql: string;
  readonly parameterOccurrences: NativeQueryContractEvidence["parameterOccurrences"];
  readonly columnSpans?: QueryContract["columnSpans"];
}
/** Grammar-owned session. Its consistency scope must cover description and both context reads. */
export interface NativeContractSession {
  context(signal?: AbortSignal): Promise<QueryContractContext>;
  describe(candidate: NativeContractCandidate, signal?: AbortSignal): Promise<NativeQueryContractEvidence>;
  close(): Promise<void>;
}
/** Explicit acquisition contribution; registration or importing it must not open a connection. */
export interface NativeContractAdapter {
  readonly id: string;
  readonly version: string;
  readonly grammar: QueryContractContext["grammar"];
  /** A grammar owner qualifies statement classes and binding/external-resource behavior before prepare. */
  accept(
    candidate: NativeContractCandidate,
  ): { readonly accepted: true } | { readonly accepted: false; readonly reason: string };
  open(signal?: AbortSignal): Promise<NativeContractSession>;
}
export type NativeContractAcquisition =
  | { readonly status: "acquired"; readonly contract: QueryContract }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "unsupported-statement"
        | "context-mismatch"
        | "context-changed"
        | "parameter-metadata-unavailable";
      readonly detail?: string;
    };

/** Explicit async evidence acquisition. No static analyzer claim or application values are inputs. */
export async function acquireNativeQueryContract(input: {
  readonly adapter: NativeContractAdapter;
  readonly candidate: NativeContractCandidate;
  readonly context: QueryContractContext;
  readonly signal?: AbortSignal;
}): Promise<NativeContractAcquisition> {
  const { adapter, signal } = input;
  signal?.throwIfAborted();
  const context = parseQueryContractContext(input.context);
  // Snapshot caller data before any asynchronous boundary so edits cannot change an in-flight request.
  const candidate: NativeContractCandidate = JSON.parse(canonicalContractData(input.candidate));
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
  if (canonicalContractData(adapter.grammar) !== canonicalContractData(context.grammar))
    throw new TypeError("Native contract adapter grammar mismatch");
  const accepted = adapter.accept(candidate);
  if (!accepted.accepted) return { status: "unavailable", reason: "unsupported-statement", detail: accepted.reason };
  const session = await adapter.open(signal);
  try {
    signal?.throwIfAborted();
    const before = parseQueryContractContext(await session.context(signal));
    signal?.throwIfAborted();
    if (canonicalContractData(before) !== canonicalContractData(context))
      return { status: "unavailable", reason: "context-mismatch" };
    const evidence = parseNativeQueryContractEvidence(await session.describe(candidate, signal), candidate.sql.length);
    signal?.throwIfAborted();
    if (evidence.adapter.id !== adapter.id || evidence.adapter.version !== adapter.version)
      throw new TypeError("Native contract evidence adapter mismatch");
    if (canonicalContractData(candidate.parameterOccurrences) !== canonicalContractData(evidence.parameterOccurrences))
      throw new TypeError("Native contract description parameter layout differs");
    const after = parseQueryContractContext(await session.context(signal));
    signal?.throwIfAborted();
    if (canonicalContractData(before) !== canonicalContractData(after))
      return { status: "unavailable", reason: "context-changed" };
    if (!nativeContractParametersAvailable(evidence))
      return { status: "unavailable", reason: "parameter-metadata-unavailable" };
    return {
      status: "acquired",
      contract: createQueryContract({
        sql: candidate.sql,
        context,
        origin: "native-description",
        nativeEvidence: evidence,
        valuePlan: nativeContractValuePlan(evidence, context),
        ...(candidate.columnSpans === undefined ? {} : { columnSpans: candidate.columnSpans }),
      }),
    };
  } finally {
    await session.close();
    signal?.throwIfAborted();
  }
}
