import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface PerformanceBudgets {
  readonly version: number;
  readonly methodology: {
    readonly warmups: number;
    readonly samples: number;
    readonly coldSamples: number;
    readonly subMillisecondIterations: number;
    readonly warningRatio: number;
  };
  readonly latencyMs: Readonly<Record<string, { readonly p50: number; readonly p95: number }>>;
  readonly throughput: Readonly<Record<string, { readonly minimumOperationsPerSecond: number }>>;
  readonly memory: Readonly<Record<string, { readonly maximum: number }>>;
}

await describe("performance regression policy", async () => {
  const budgets = JSON.parse(await readFile(join(workspace, "performance-budgets.json"), "utf8")) as PerformanceBudgets;

  await it("uses versioned percentile methodology and complete release metrics", () => {
    strict.ok(Number.isSafeInteger(budgets.version) && budgets.version > 0);
    strict.ok(budgets.methodology.warmups >= 1);
    strict.ok(budgets.methodology.samples >= 20);
    strict.ok(budgets.methodology.coldSamples >= 10);
    strict.ok(budgets.methodology.subMillisecondIterations >= 100);
    strict.ok(budgets.methodology.warningRatio > 0 && budgets.methodology.warningRatio < 1);
    strict.deepStrictEqual(Object.keys(budgets.latencyMs).sort(), [
      "compiler.correlatedConditions",
      "compiler.independentConditions",
      "compiler.manyQueries",
      "compiler.structuralLimit",
      "editor.cancelledRequest",
      "editor.coldAnalysis",
      "editor.incrementalAnalysis",
      "editor.schemaReload",
      "editor.unchangedAnalysis",
      "scanner.largeFile",
    ]);
    for (const [name, budget] of Object.entries(budgets.latencyMs)) {
      strict.ok(budget.p50 > 0, `${name} has no p50 budget`);
      strict.ok(budget.p95 >= budget.p50, `${name} p95 is below p50`);
    }
    strict.ok((budgets.throughput["core.composeAndRender"]?.minimumOperationsPerSecond ?? 0) > 0);
    strict.ok((budgets.memory["editor.retainedHeapMiB"]?.maximum ?? 0) > 0);
  });

  await it("runs the gate after production build and records reproducibility context", async () => {
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const verify = manifest.scripts.verify ?? "";
    strict.ok(verify.indexOf("pnpm build") < verify.indexOf("pnpm performance:gate"));
    strict.ok(manifest.scripts.performance?.startsWith("pnpm build &&"));

    const gate = await readFile(join(workspace, "scripts", "performance-gate.mjs"), "utf8");
    for (const evidence of [
      "/dist/",
      "coefficientOfVariation",
      "cpuModel",
      "productionBuild: true",
      "globalThis.gc",
      '"TSQ003"',
      "expectedAnalyses",
      "cacheSizes",
      "isCancellationRequested",
      "iterationsPerSample",
      "methodology.subMillisecondIterations",
    ]) {
      strict.ok(gate.includes(evidence), `performance gate does not record ${evidence}`);
    }
    strict.strictEqual(
      gate.match(/iterations: methodology\.subMillisecondIterations/gu)?.length,
      2,
      "cache-hit and cancellation fast paths must batch samples",
    );
  });

  await it("keeps the public driver and ORM comparison reproducible and isolated", async () => {
    const benchmark = join(workspace, "benchmarks", "runtime-comparison");
    const manifest = JSON.parse(await readFile(join(benchmark, "package.json"), "utf8")) as {
      readonly private: boolean;
      readonly scripts: Readonly<Record<string, string>>;
      readonly dependencies: Readonly<Record<string, string>>;
    };
    strict.strictEqual(manifest.private, true);
    strict.ok(manifest.scripts.run?.includes("databases:start"));
    strict.ok(manifest.scripts.run?.includes("generate"));
    strict.ok(manifest.scripts.run?.includes("benchmark"));
    for (const dependency of [
      "@prisma/adapter-pg",
      "@prisma/client",
      "@typed-sql/mysql",
      "@typed-sql/postgres",
      "drizzle-orm",
      "kysely",
      "mysql2",
      "pg",
      "typeorm",
    ]) {
      strict.ok(manifest.dependencies[dependency] !== undefined, `comparison does not pin ${dependency}`);
    }
    const compose = await readFile(join(benchmark, "compose.yaml"), "utf8");
    strict.ok(compose.includes("postgres:18.0-alpine"));
    strict.ok(compose.includes("mysql:9.5"));
    strict.ok(compose.includes("healthcheck:"));
    const documentation = await readFile(join(benchmark, "README.md"), "utf8");
    strict.ok(documentation.includes("not a universal leaderboard"));
    strict.ok(documentation.includes("generated numbers are intentionally ignored"));
  });
});
