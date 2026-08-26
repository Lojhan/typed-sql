import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSource, extractStaticQueries } from "../packages/compiler/dist/packages/compiler/src/index.js";
import { renderQuery, sql } from "../packages/core/dist/packages/core/src/index.js";
import { TypedSqlLanguageService } from "../packages/language-server/dist/packages/language-server/src/index.js";
import { postgres } from "../packages/postgres/dist/packages/postgres/src/index.js";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(await readFile(join(workspace, "performance-budgets.json"), "utf8"));
const methodology = budgets.methodology;
const results = {};
const processors = cpus();
const context = {
  node: process.version,
  platform: platform(),
  platformRelease: release(),
  architecture: process.arch,
  cpuModel: processors[0]?.model ?? "unknown",
  logicalCpuCount: processors.length,
  totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
  ci: process.env.CI === "true",
  productionBuild: true,
  budgetVersion: budgets.version,
};
console.log(`typed-sql performance context\n${JSON.stringify(context, null, 2)}`);

function percentile(samples, quantile) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

function statistics(samples) {
  const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length;
  const variance = samples.reduce((total, sample) => total + (sample - mean) ** 2, 0) / samples.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    samples: samples.length,
    minimum: Math.min(...samples),
    mean,
    standardDeviation,
    coefficientOfVariation: mean === 0 ? 0 : standardDeviation / mean,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    maximum: Math.max(...samples),
  };
}

async function latency(name, operation, options = {}) {
  const warmups = options.warmups ?? methodology.warmups;
  const sampleCount = options.samples ?? methodology.samples;
  const iterations = options.iterations ?? 1;
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await operation(warmup * iterations + iteration);
    }
  }
  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await operation(sample * iterations + iteration);
    }
    samples.push((performance.now() - start) / iterations);
  }
  const measured = statistics(samples);
  const budget = budgets.latencyMs[name];
  assert.ok(budget !== undefined, `Missing latency budget for ${name}`);
  results[name] = { unit: "ms", iterationsPerSample: iterations, ...measured, budget };
  warnNearBudget(name, measured.p50, budget.p50, "p50");
  warnNearBudget(name, measured.p95, budget.p95, "p95");
  assert.ok(measured.p50 <= budget.p50, `${name} p50 ${measured.p50.toFixed(2)}ms exceeded ${budget.p50}ms`);
  assert.ok(measured.p95 <= budget.p95, `${name} p95 ${measured.p95.toFixed(2)}ms exceeded ${budget.p95}ms`);
}

function warnNearBudget(name, actual, maximum, statistic) {
  if (actual <= maximum * methodology.warningRatio) return;
  const message = `${name} ${statistic} ${actual.toFixed(2)} is above ${Math.round(methodology.warningRatio * 100)}% of ${maximum}`;
  warn(message);
}

function warn(message) {
  if (process.env.GITHUB_ACTIONS === "true") console.warn(`::warning title=typed-sql performance::${message}`);
  else console.warn(`WARNING ${message}`);
}

function manyQuerySource(count) {
  return [
    'import { sql } from "@typed-sql/postgres";',
    ...Array.from(
      { length: count },
      (_, index) =>
        `export const query_${index} = sql\`SELECT account.id, account.email FROM users AS account WHERE account.id >= \${${index}n}\`;`,
    ),
  ].join("\n");
}

function structuralSource(conditions) {
  return [
    'import { sql } from "@typed-sql/postgres";',
    `interface Selection { ${[...new Set(conditions)].map((name) => `${name}: boolean`).join("; ")} }`,
    "export function accounts<const Select extends Selection>(select: Select) {",
    "  return sql`SELECT account.id, account.email",
    ...conditions.map(
      (name, index) => `    \${select.${name} ? sql.fragment\`, ${index + 1} AS value_${index}\` : sql.empty}`,
    ),
    "    FROM users AS account`;",
    "}",
  ].join("\n");
}

const snapshot = {
  formatVersion: 1,
  dialect: "postgres",
  dialectVersion: "1.0.0",
  tables: {
    users: {
      name: "users",
      columns: {
        id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
        email: { name: "email", databaseType: "text", tsType: "string", nullable: false },
      },
    },
  },
};
const dialect = postgres();
const scannerSource = manyQuerySource(1_000);
const compilerSource = manyQuerySource(250);

await latency("scanner.largeFile", () => {
  const extracted = extractStaticQueries(scannerSource, (index) => `$${index}`, ["@typed-sql/postgres"]);
  assert.equal(extracted.length, 1_000);
});

await latency("compiler.manyQueries", () => {
  const compiled = compileSource({ source: compilerSource, schema: snapshot, dialect });
  assert.equal(compiled.queries.length, 250);
  assert.deepEqual(compiled.diagnostics, []);
});

async function structuralMetric(name, conditions, expectedAnalyses, expectedCode) {
  let analyses = 0;
  const measuredDialect = {
    ...dialect,
    analyze(...args) {
      analyses += 1;
      return dialect.analyze(...args);
    },
  };
  await latency(name, () => {
    analyses = 0;
    const compiled = compileSource({
      source: structuralSource(conditions),
      schema: snapshot,
      dialect: measuredDialect,
      maxStructuralVariants: 64,
    });
    assert.equal(analyses, expectedAnalyses);
    if (expectedCode === undefined) {
      assert.deepEqual(compiled.diagnostics, []);
      assert.equal(compiled.queries.length, 1);
    } else {
      assert.equal(compiled.diagnostics[0]?.code, expectedCode);
      assert.equal(compiled.queries.length, 0);
    }
  });
}

await structuralMetric(
  "compiler.correlatedConditions",
  Array.from({ length: 20 }, () => "details"),
  2,
);
await structuralMetric(
  "compiler.independentConditions",
  Array.from({ length: 6 }, (_, index) => `field_${index}`),
  64,
);
await structuralMetric(
  "compiler.structuralLimit",
  Array.from({ length: 20 }, (_, index) => `field_${index}`),
  0,
  "TSQ003",
);

const coreIterations = 10_000;
const coreSamples = [];
for (let warmup = 0; warmup < methodology.warmups; warmup += 1) {
  for (let index = 0; index < coreIterations; index += 1) {
    renderQuery(sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${index}`, dialect);
  }
}
for (let sample = 0; sample < methodology.samples; sample += 1) {
  const start = performance.now();
  for (let index = 0; index < coreIterations; index += 1) {
    const predicate = sql.and([
      sql.fragment`account.id >= ${index}`,
      index % 2 === 0 ? sql.fragment`account.email = ${"person@example.com"}` : undefined,
    ]);
    renderQuery(sql`SELECT ${sql.ident("id")} FROM users AS account WHERE ${predicate}`, dialect);
  }
  coreSamples.push((coreIterations * 1_000) / (performance.now() - start));
}
const coreThroughput = statistics(coreSamples);
const coreBudget = budgets.throughput["core.composeAndRender"];
results["core.composeAndRender"] = { unit: "operations/second", ...coreThroughput, budget: coreBudget };
if (coreThroughput.p50 < coreBudget.minimumOperationsPerSecond / methodology.warningRatio) {
  warn(
    `core.composeAndRender p50 ${coreThroughput.p50.toFixed(0)} ops/s is approaching ${coreBudget.minimumOperationsPerSecond}`,
  );
}
assert.ok(
  coreThroughput.p50 >= coreBudget.minimumOperationsPerSecond,
  `core.composeAndRender p50 ${coreThroughput.p50.toFixed(0)} ops/s fell below ${coreBudget.minimumOperationsPerSecond}`,
);

const temporary = await mkdtemp(join(tmpdir(), "typed-sql-performance-"));
try {
  const schemaPath = join(temporary, "schema.json");
  const configPath = join(temporary, "typed-sql.config.mjs");
  const postgresModule = pathToFileURL(join(workspace, "packages/postgres/dist/packages/postgres/src/index.js")).href;
  await writeFile(schemaPath, `${JSON.stringify(snapshot)}\n`);
  await writeFile(
    configPath,
    `import { postgres } from ${JSON.stringify(postgresModule)};\nexport default { dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated" };\n`,
  );
  const editorSource = manyQuerySource(120);
  const editorDocument = (name, version, text = editorSource) => ({
    uri: pathToFileURL(join(temporary, name)).href,
    languageId: "typescript",
    version,
    getText: () => text,
  });
  const settings = { configPath, schemaPath, nativePreview: false, maxCacheEntries: 32 };

  await latency(
    "editor.coldAnalysis",
    async (index) => {
      const service = new TypedSqlLanguageService(temporary, settings);
      try {
        const analysis = await service.analysis(editorDocument(`cold-${index}.ts`, 1));
        assert.equal(analysis?.queries.length, 120);
      } finally {
        await service.close();
      }
    },
    { warmups: 1, samples: methodology.coldSamples },
  );

  const service = new TypedSqlLanguageService(temporary, settings);
  try {
    const uriName = "incremental.ts";
    await service.analysis(editorDocument(uriName, 1));
    await latency(
      "editor.unchangedAnalysis",
      async () => {
        const analysis = await service.analysis(editorDocument(uriName, 1));
        assert.equal(analysis?.queries.length, 120);
      },
      { iterations: methodology.subMillisecondIterations },
    );

    let version = 1;
    await latency("editor.incrementalAnalysis", async (index) => {
      version += 1;
      const analysis = await service.analysis(editorDocument(uriName, version, `${editorSource}\n// edit ${index}`));
      assert.equal(analysis?.queries.length, 120);
    });

    await latency(
      "editor.schemaReload",
      async (index) => {
        const modified = new Date(Date.now() + (index + 1) * 1_000);
        await utimes(schemaPath, modified, modified);
        const analysis = await service.analysis(editorDocument(uriName, version));
        assert.equal(analysis?.queries.length, 120);
      },
      { warmups: 1, samples: methodology.coldSamples },
    );

    await latency("editor.cancelledRequest", async () => {
      let checks = 0;
      await assert.rejects(
        () =>
          service.analysis(editorDocument("cancelled.ts", 1, manyQuerySource(2_000)), {
            get isCancellationRequested() {
              checks += 1;
              return checks > 1;
            },
          }),
        (error) => error instanceof Error && error.name === "AbortError",
      );
    });

    service.invalidate();
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 128; index += 1) {
      const analysis = await service.analysis(
        editorDocument(`memory-${index}.ts`, 1, `${manyQuerySource(100)}\n// document ${index}`),
      );
      assert.equal(analysis?.queries.length, 100);
    }
    globalThis.gc?.();
    const retainedHeapMiB = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    const memoryBudget = budgets.memory["editor.retainedHeapMiB"];
    results["editor.retainedHeapMiB"] = {
      unit: "MiB",
      value: retainedHeapMiB,
      budget: memoryBudget,
      cacheSizes: service.cacheSizes(),
    };
    if (retainedHeapMiB > memoryBudget.maximum * methodology.warningRatio) {
      warn(`editor.retainedHeapMiB ${retainedHeapMiB.toFixed(2)}MiB is approaching ${memoryBudget.maximum}MiB`);
    }
    assert.ok(service.cacheSizes().analyses <= 32);
    assert.ok(
      retainedHeapMiB <= memoryBudget.maximum,
      `editor.retainedHeapMiB ${retainedHeapMiB.toFixed(2)}MiB exceeded ${memoryBudget.maximum}MiB`,
    );
  } finally {
    await service.close();
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      context,
      results,
    },
    null,
    2,
  ),
);
