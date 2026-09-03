import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import {
  capturePerformanceContext,
  createPerformanceArtifact,
  measureLatency,
  measureThroughput,
  percentile,
  statistics,
  summarizePerformanceResults,
  writePerformanceArtifact,
} from "../../scripts/performance/harness.mjs";

function clock(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("deterministic clock exhausted");
    return value;
  };
}

await describe("performance harness", async () => {
  await it("computes nearest-rank percentiles and complete statistics", () => {
    strict.strictEqual(percentile([9, 1, 5, 3], 0), 1);
    strict.strictEqual(percentile([9, 1, 5, 3], 0.5), 3);
    strict.strictEqual(percentile([9, 1, 5, 3], 0.95), 9);
    strict.strictEqual(percentile([9, 1, 5, 3], 0.99), 9);
    strict.deepStrictEqual(statistics([1, 2, 3]), {
      samples: 3,
      minimum: 1,
      mean: 2,
      standardDeviation: Math.sqrt(2 / 3),
      coefficientOfVariation: Math.sqrt(2 / 3) / 2,
      p50: 2,
      p95: 3,
      p99: 3,
      maximum: 3,
    });
    strict.throws(() => percentile([], 0.5), /non-empty/u);
    strict.throws(() => percentile([1], 1.1), /between zero and one/u);
    strict.throws(() => statistics([Number.NaN]), /finite numbers/u);
  });

  await it("measures async latency with deterministic warm-up and sample indexes", async () => {
    const indexes: number[] = [];
    const measured = await measureLatency({
      operation: async (index) => indexes.push(index),
      warmups: 1,
      samples: 2,
      iterations: 2,
      clock: clock([0, 20, 20, 60]),
    });

    strict.deepStrictEqual(indexes, [0, 1, 0, 1, 2, 3]);
    strict.deepStrictEqual(measured.rawSamples, [10, 20]);
    strict.strictEqual(measured.iterationsPerSample, 2);
    strict.strictEqual(measured.p50, 10);
    strict.strictEqual(measured.p95, 20);
    strict.strictEqual(measured.p99, 20);
  });

  await it("measures synchronous throughput without adding promise scheduling", () => {
    const indexes: number[] = [];
    const measured = measureThroughput({
      operation: (index) => indexes.push(index),
      warmups: 1,
      samples: 2,
      iterations: 2,
      clock: clock([0, 10, 10, 30]),
    });

    strict.deepStrictEqual(indexes, [0, 1, 0, 1, 2, 3]);
    strict.deepStrictEqual(measured.rawSamples, [200, 100]);
    strict.strictEqual(measured.p50, 100);
    strict.strictEqual(measured.p95, 200);
    strict.strictEqual(measured.p99, 200);
  });

  await it("captures reproducibility context from injectable system and git inputs", () => {
    const context = capturePerformanceContext({
      budgetVersion: 2,
      productionBuild: true,
      workspace: "/workspace",
      environment: { CI: "true", npm_config_user_agent: "pnpm/10.32.1 node/v24.10.0" },
      system: {
        node: "v24.10.0",
        platform: "test-os",
        platformRelease: "1.2.3",
        architecture: "test-arch",
        processors: [{ model: "test-cpu" }, { model: "test-cpu" }],
        totalMemoryBytes: 8 * 1024 * 1024,
      },
      git: { gitRevision: "0123456789", gitDirty: false },
    });

    strict.deepStrictEqual(context, {
      node: "v24.10.0",
      platform: "test-os",
      platformRelease: "1.2.3",
      architecture: "test-arch",
      cpuModel: "test-cpu",
      logicalCpuCount: 2,
      totalMemoryMiB: 8,
      ci: true,
      productionBuild: true,
      budgetVersion: 2,
      packageManager: "pnpm/10.32.1",
      gitRevision: "0123456789",
      gitDirty: false,
    });
  });

  await it("writes versioned machine-readable artifacts and creates parent directories", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-performance-harness-"));
    try {
      const context = capturePerformanceContext({
        budgetVersion: 2,
        productionBuild: true,
        workspace: temporary,
        environment: {},
        system: {
          node: "v24.10.0",
          platform: "test-os",
          platformRelease: "1.2.3",
          architecture: "test-arch",
          processors: [{ model: "test-cpu" }],
          totalMemoryBytes: 1024 * 1024,
        },
        git: { gitRevision: "revision", gitDirty: true },
      });
      const artifact = createPerformanceArtifact(
        context,
        { render: { unit: "operations/second", p50: 100 } },
        new Date("2026-08-26T12:00:00.000Z"),
      );
      const path = join(temporary, "nested", "performance.json");
      await writePerformanceArtifact(path, artifact);

      strict.deepStrictEqual(JSON.parse(await readFile(path, "utf8")), artifact);
      strict.strictEqual(artifact.formatVersion, 1);
      strict.strictEqual(artifact.generatedAt, "2026-08-26T12:00:00.000Z");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("keeps raw samples in artifacts but removes them from console summaries", () => {
    const result = { unit: "ms", rawSamples: [1, 2], p50: 1, budget: { p50: 5 } };
    const results = { measured: result, memory: { unit: "MiB", value: 2 } };

    strict.deepStrictEqual(summarizePerformanceResults(results), {
      measured: { unit: "ms", p50: 1, budget: { p50: 5 } },
      memory: results.memory,
    });
    strict.deepStrictEqual(result.rawSamples, [1, 2]);
  });
});
