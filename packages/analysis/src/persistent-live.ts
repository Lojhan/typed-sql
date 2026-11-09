import type { AnalysisCache, AnalysisCacheToken } from "./cache.js";
import { type LiveAnalysisRunner, parseLiveAnalysisOutcome, parseLiveAnalysisRequest } from "./live.js";

/** An explicitly live producer always acquires evidence, even when matching bytes are cached. */
export function createPersistentLiveAnalysisRunner(input: {
  readonly cache: AnalysisCache;
  readonly run: LiveAnalysisRunner;
  readonly onCacheSnapshot?: (token: AnalysisCacheToken) => void;
}): LiveAnalysisRunner {
  return async (source, signal) => {
    const request = parseLiveAnalysisRequest(source);
    signal.throwIfAborted();
    const captured = await input.cache.lookup(request);
    signal.throwIfAborted();
    const outcome = parseLiveAnalysisOutcome(await input.run(request, signal), request);
    signal.throwIfAborted();
    // Availability and retry policy do not disprove recorded-context evidence.
    if (outcome.kind === "unavailable") return outcome;
    const published = await input.cache.publish({ token: captured.token, request, outcome });
    signal.throwIfAborted();
    if (published.status === "superseded")
      return Object.freeze({ kind: "unavailable", code: "cache-publication-superseded", retry: "change" });
    input.onCacheSnapshot?.(
      published.status === "published"
        ? Object.freeze({ ...captured.token, entryRevision: published.revision })
        : captured.token,
    );
    // Capacity can prevent persistence, but cannot invalidate independently qualified fresh evidence.
    return outcome;
  };
}
