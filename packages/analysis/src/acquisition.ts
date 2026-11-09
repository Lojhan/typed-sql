import { type NativeContractCandidate, parseNativeContractCandidate } from "./candidate.js";
import { canonicalContractData } from "./canonical.js";
import {
  createQueryContract,
  parseQueryContractContext,
  type QueryContract,
  type QueryContractContext,
} from "./contracts.js";
import type { LiveAnalysisFailure } from "./live.js";
import {
  type NativeQueryContractEvidence,
  nativeContractParametersAvailable,
  nativeContractValuePlan,
  parseNativeQueryContractEvidence,
} from "./native-evidence.js";

import type { ProjectCatalog } from "./project-catalog.js";

export type { NativeContractCandidate } from "./candidate.js";

/** Grammar-owned session. Its consistency scope must cover description and both context reads. */
export interface NativeContractSession {
  context(signal?: AbortSignal): Promise<QueryContractContext>;
  describe(candidate: NativeContractCandidate, signal?: AbortSignal): Promise<NativeQueryContractEvidence>;
  projectCatalog?(sql: readonly string[], context: QueryContractContext, signal?: AbortSignal): Promise<ProjectCatalog>;
  close(): Promise<void>;
}
/** Explicit acquisition contribution; registration or importing it must not open a connection. */
export interface NativeContractAdapter {
  readonly id: string;
  readonly version: string;
  readonly grammar: QueryContractContext["grammar"];
  readonly projectCatalogOwner?: ProjectCatalog["owner"];
  /** Sanitized grammar/transport-owned failures; never includes SQL or driver messages. */
  classifyError?(error: unknown): LiveAnalysisFailure;
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
  const candidate = parseNativeContractCandidate(input.candidate);
  if (canonicalContractData(adapter.grammar) !== canonicalContractData(context.grammar))
    throw new TypeError("Native contract adapter grammar mismatch");
  const accepted = adapter.accept(candidate);
  if (!accepted.accepted) return { status: "unavailable", reason: "unsupported-statement", detail: accepted.reason };
  const session = await adapter.open(signal);
  const [operation] = await Promise.allSettled([
    (async (): Promise<NativeContractAcquisition> => {
      signal?.throwIfAborted();
      const before = parseQueryContractContext(await session.context(signal));
      signal?.throwIfAborted();
      if (canonicalContractData(before) !== canonicalContractData(context))
        return { status: "unavailable", reason: "context-mismatch" };
      const evidence = parseNativeQueryContractEvidence(
        await session.describe(candidate, signal),
        candidate.sql.length,
      );
      signal?.throwIfAborted();
      if (evidence.adapter.id !== adapter.id || evidence.adapter.version !== adapter.version)
        throw new TypeError("Native contract evidence adapter mismatch");
      if (
        canonicalContractData(candidate.parameterOccurrences) !== canonicalContractData(evidence.parameterOccurrences)
      )
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
    })(),
  ]);
  const [cleanup] = await Promise.allSettled([Promise.resolve().then(() => session.close())]);
  signal?.throwIfAborted();
  if (operation.status === "rejected") {
    if (cleanup.status === "rejected")
      throw new AggregateError([operation.reason, cleanup.reason], "Native acquisition and cleanup failed");
    throw operation.reason;
  }
  // Cleanup cannot turn confirmed negative evidence into an availability-only outcome.
  // A positive contract, however, requires successful cleanup as well as acquisition.
  if (cleanup.status === "rejected" && operation.value.status === "acquired") throw cleanup.reason;
  return operation.value;
}
