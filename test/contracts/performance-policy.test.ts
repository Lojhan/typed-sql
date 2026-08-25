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
    ]) {
      strict.ok(gate.includes(evidence), `performance gate does not record ${evidence}`);
    }
  });
});
