import type { AnalysisCache } from "./cache.js";
import { type LiveAnalysisRunner, parseLiveAnalysisOutcome, parseLiveAnalysisRequest } from "./live.js";

/** An explicitly live producer always acquires evidence, even when matching bytes are cached. */
export function createPersistentLiveAnalysisRunner(input: {
  readonly cache: AnalysisCache;
  readonly run: LiveAnalysisRunner;
}): LiveAnalysisRunner {
  return async (source, signal) => {
    const request = parseLiveAnalysisRequest(source);
    signal.throwIfAborted();
    const captured = await input.cache.lookup(request);
    signal.throwIfAborted();
    const outcome = parseLiveAnalysisOutcome(await input.run(request, signal), request);
    signal.throwIfAborted();
    // A transport outage does not disprove recorded-context evidence or replace it on disk.
    if (outcome.kind === "unavailable" && outcome.retry === "transport") return outcome;
    const published = await input.cache.publish({ token: captured.token, request, outcome });
    signal.throwIfAborted();
    if (published.status === "superseded")
      return Object.freeze({ kind: "unavailable", code: "cache-publication-superseded", retry: "change" });
    // Capacity can prevent persistence, but cannot invalidate independently qualified fresh evidence.
    return outcome;
  };
}
