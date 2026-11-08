import { parseQueryContractContext } from "./contracts.js";
import { parseLiveAnalysisFailure } from "./live.js";
import type { LiveAnalysisServices } from "./registration.js";

/** Internal retry signal; only an explicitly classified native guard contradiction creates it. */
export class NativeContextChangedError extends Error {}
export class NativeContextObservationChangedError extends NativeContextChangedError {}

export async function inspectNativeContext(services: LiveAnalysisServices, signal: AbortSignal) {
  let observed: unknown;
  try {
    observed = await services.inspectContext(signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof NativeContextChangedError) throw error;
    const failure = services.classifyError?.(error) ?? services.adapter.classifyError?.(error);
    if (failure && parseLiveAnalysisFailure(failure).kind === "stale-context")
      throw new NativeContextObservationChangedError("Database context changed while observing native metadata");
    throw error;
  }
  signal.throwIfAborted();
  // Invalid returned metadata is not a transient guard failure.
  return parseQueryContractContext(observed);
}
