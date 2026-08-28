import { performance } from "node:perf_hooks";
import type { SchemaSnapshot } from "@typed-sql/core";
import type { GrammarPerformanceOptions, GrammarPerformanceResult } from "./types.js";

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}

/**
 * Measures complete grammar analysis batches. Consumers choose environment-specific budgets and
 * record the returned percentile evidence instead of relying on a machine-independent threshold.
 */
export function measureGrammarPerformance<Snapshot extends SchemaSnapshot, Policy>(
  options: GrammarPerformanceOptions<Snapshot, Policy>,
): GrammarPerformanceResult {
  if (options.queries.length === 0) throw new TypeError("Grammar performance queries must not be empty");
  const warmups = positiveInteger(options.warmups ?? 3, "warmups");
  const samples = positiveInteger(options.samples ?? 20, "samples");
  const run = (): number => {
    const start = performance.now();
    for (const query of options.queries) options.dialect.analyze(query, options.snapshot, options.policy);
    return performance.now() - start;
  };
  for (let index = 0; index < warmups; index += 1) run();
  const durations = Array.from({ length: samples }, run);
  const slowest = Math.max(...durations);
  return Object.freeze({
    queryCount: options.queries.length,
    warmups,
    samples,
    p50Milliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95),
    minimumQueriesPerSecond: (options.queries.length * 1_000) / slowest,
  });
}
