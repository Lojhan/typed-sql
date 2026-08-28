import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildQueryManifest,
  collectQueryVerificationCandidates,
  compileSource,
  extractStaticQueries,
  verifyQueryManifest,
} from "../packages/compiler/dist/packages/compiler/src/index.js";
import { renderQuery, sql } from "../packages/core/dist/packages/core/src/index.js";
import { TypedSqlLanguageService } from "../packages/language-server/dist/packages/language-server/src/index.js";
import { postgres } from "../packages/postgres/dist/packages/postgres/src/index.js";
import {
  capturePerformanceContext,
  createPerformanceArtifact,
  measureLatency,
  measureThroughput,
  summarizePerformanceResults,
  writePerformanceArtifact,
} from "./performance/harness.mjs";
import { deterministicMicrobenchmarks } from "./performance/microbenchmarks.mjs";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(await readFile(join(workspace, "performance-budgets.json"), "utf8"));
const methodology = budgets.methodology;
const results = {};
const context = capturePerformanceContext({
  workspace,
  productionBuild: true,
  budgetVersion: budgets.version,
});
assert.equal(typeof context.cpuModel, "string");
console.log(`typed-sql performance context\n${JSON.stringify(context, null, 2)}`);

async function latency(name, operation, options = {}) {
  const warmups = options.warmups ?? methodology.warmups;
  const sampleCount = options.samples ?? methodology.samples;
  const iterations = options.iterations ?? 1;
  const measured = await measureLatency({ operation, warmups, samples: sampleCount, iterations });
  assert.ok(Number.isFinite(measured.coefficientOfVariation));
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

const manifestOptions = {
  rootDir: "/benchmark/project",
  sources: [{ file: "/benchmark/project/src/queries.ts", source: compilerSource }],
  projects: ["/benchmark/project/tsconfig.json"],
  schema: snapshot,
  dialect,
  compilerVersion: "performance",
};
await latency("compiler.queryManifest", () => {
  const result = buildQueryManifest(manifestOptions);
  assert.equal(result.manifest.queries.length, 250);
  assert.equal(result.stats.analyzedFiles, 1);
});
const previousManifest = buildQueryManifest(manifestOptions).manifest;
await latency(
  "compiler.queryManifestIncremental",
  () => {
    const result = buildQueryManifest({ ...manifestOptions, previous: previousManifest });
    assert.equal(result.manifest.queries.length, 250);
    assert.equal(result.stats.reusedFiles, 1);
  },
  { iterations: methodology.subMillisecondIterations },
);

const verificationCandidates = collectQueryVerificationCandidates({
  ...manifestOptions,
  manifest: previousManifest,
});
const verificationByFingerprint = new Map(
  verificationCandidates.map((candidate) => [candidate.variantFingerprint, candidate]),
);
const benchmarkVerifier = {
  dialect: "postgres",
  adapterVersion: "performance-v1",
  async server() {
    return { version: "18-performance" };
  },
  async verify(request) {
    const candidate = verificationByFingerprint.get(request.fingerprint);
    assert.ok(candidate !== undefined);
    const field = ({ index, name, databaseType, tsType, nullable }) => ({
      index,
      ...(name === undefined ? {} : { name }),
      ...(databaseType === undefined ? {} : { databaseType }),
      tsType,
      nullable,
    });
    return { columns: candidate.columns.map(field), parameters: candidate.parameters.map(field) };
  },
  async close() {},
};
await latency("compiler.queryVerification", async () => {
  const result = await verifyQueryManifest({
    manifest: previousManifest,
    candidates: verificationCandidates,
    verifier: benchmarkVerifier,
    concurrency: 8,
  });
  assert.equal(result.verified, 250);
});

const semanticQueries = Array.from(
  { length: 250 },
  (_, index) => `SELECT account.id, account.email FROM users AS account WHERE account.id >= $${index + 1}`,
);
await latency("compiler.semanticMetadata", () => {
  for (const query of semanticQueries) {
    const analysis = dialect.analyze(query, snapshot);
    assert.equal(analysis.semantics.operation.value, "read");
    assert.equal(
      analysis.semantics.dependencies.some(({ kind }) => kind === "relation"),
      true,
    );
  }
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
const coreThroughput = measureThroughput({
  warmups: methodology.warmups,
  samples: methodology.samples,
  iterations: coreIterations,
  warmupOperation(index) {
    renderQuery(sql`SELECT ${sql.ident("id")} FROM users WHERE id = ${index}`, dialect);
  },
  operation(index) {
    const predicate = sql.and([
      sql.fragment`account.id >= ${index}`,
      index % 2 === 0 ? sql.fragment`account.email = ${"person@example.com"}` : undefined,
    ]);
    renderQuery(sql`SELECT ${sql.ident("id")} FROM users AS account WHERE ${predicate}`, dialect);
  },
});
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

Object.assign(results, await deterministicMicrobenchmarks(methodology));

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

    const cancelledDocument = editorDocument("cancelled.ts", 1, manyQuerySource(2_000));
    await latency(
      "editor.cancelledRequest",
      async () => {
        let checks = 0;
        await assert.rejects(
          () =>
            service.analysis(cancelledDocument, {
              get isCancellationRequested() {
                checks += 1;
                return checks > 1;
              },
            }),
          (error) => error instanceof Error && error.name === "AbortError",
        );
      },
      { iterations: methodology.subMillisecondIterations },
    );

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

const artifact = createPerformanceArtifact(context, results);
const artifactPath = process.env.TYPED_SQL_PERFORMANCE_ARTIFACT;
if (artifactPath !== undefined) await writePerformanceArtifact(resolve(workspace, artifactPath), artifact);
console.log(JSON.stringify({ context, results: summarizePerformanceResults(results) }, null, 2));
