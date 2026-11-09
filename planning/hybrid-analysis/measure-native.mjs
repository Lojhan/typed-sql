import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createNativeLiveAnalysisRunner,
  createStaticQueryClaim,
  exactSqlDigest,
  exportQueryContracts,
  loadQueryContracts,
  openAnalysisCache,
  queryContractDigest,
  serializeQueryContract,
} from "../../packages/analysis/dist/packages/analysis/src/index.js";

import { calculateSchemaHash, serializeSchemaSnapshot } from "../../packages/schema/dist/packages/schema/src/index.js";

async function fileBytes(directory) {
  let bytes = 0,
    files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await fileBytes(path);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += (await readFile(path)).byteLength;
      files++;
    } else throw Error("Unexpected measurement filesystem entry");
  }
  return { bytes, files };
}
async function elapsed(run) {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

/**
 * Opt-in measurement of an already qualified owner fixture, with actual native acquisition.
 * Ordinary package tests do not enable this or perform its additional native round trips.
 * @param {import("./measure-native.mjs").NativeCostFixture} input
 */
export async function recordNativeCosts(input) {
  const configured = process.env.TYPED_SQL_NATIVE_COSTS_DIRECTORY;
  if (!configured) return;
  assert.match(input.label, /^[a-z0-9._-]{1,160}$/iu);
  assert.ok(input.serverVersion.length > 0);
  const directory = resolve(configured);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${input.label}.json`);
  // A failed new observation must not leave an older report looking current.
  await rm(destination, { force: true });
  const temporary = await mkdtemp(join(directory, ".native-cost-"));
  const samples = [];
  const run = createNativeLiveAnalysisRunner({ adapter: input.adapter, contribution: input.contribution });
  try {
    for (let sample = 0; sample < 3; sample++) {
      const attempts = [];
      let qualified;
      for (let attempt = 0; attempt < 3; attempt++) {
        const inspected = await elapsed(() => input.adapter.inspectContext());
        const analyzed = await elapsed(() => input.analyze(input.candidate.sql));
        const request = {
          adapter: { id: input.adapter.id, version: input.adapter.version },
          candidate: input.candidate,
          connectionContext: queryContractDigest("owned-native-cost-target"),
          staticClaim: createStaticQueryClaim({
            sql: input.candidate.sql,
            context: inspected.value,
            analysis: analyzed.value,
          }),
          policy: input.policy,
        };
        const acquired = await elapsed(() => run(request, new AbortController().signal));
        attempts.push({
          contextInspectionMs: inspected.ms,
          staticAnalysisMs: analyzed.ms,
          acquisitionAndReconciliationMs: acquired.ms,
          outcome: acquired.value.kind,
        });
        if (acquired.value.kind === "stale-context" && attempt < 2) continue;
        assert.equal(
          acquired.value.kind,
          "usable-recorded-context",
          "Cost measurements require independently qualified evidence",
        );
        if (acquired.value.kind !== "usable-recorded-context") throw Error("Native cost qualification failed");
        qualified = { request, outcome: acquired.value };
        break;
      }
      assert.ok(qualified);
      const { request, outcome } = qualified;
      assert.equal(outcome.contract.context.schemaHash, calculateSchemaHash(input.schema));
      const closure = join(temporary, `closure-${sample}`);
      const exported = await elapsed(() => exportQueryContracts(closure, [outcome.contract]));
      const loaded = await elapsed(() => loadQueryContracts(closure));
      assert.equal(loaded.value.length, 1);
      assert.equal(loaded.value[0].digest, outcome.contract.digest);
      const cacheOptions = {
        directory: join(temporary, `cache-${sample}`),
        workspaceContext: queryContractDigest("owned-native-cost-workspace"),
      };
      const cache = await openAnalysisCache(cacheOptions);
      const token = (await cache.lookup(request)).token;
      const published = await elapsed(() => cache.publish({ token, request, outcome }));
      assert.equal(published.value.status, "published");
      const recorded = {
        candidate: request.candidate,
        context: request.staticClaim.context,
        connectionContext: request.connectionContext,
        adapter: request.adapter,
        policy: request.policy,
      };
      // Cold means a new cache object reading existing files, not a dropped OS page cache.
      const cold = await elapsed(async () => (await openAnalysisCache(cacheOptions)).lookupRecorded(recorded));
      assert.equal(cold.value.cached?.outcome.kind, "usable-recorded-context");
      assert.equal(cold.value.cached?.freshness, "unverified");
      const warmCache = await openAnalysisCache(cacheOptions);
      await warmCache.lookupRecorded(recorded);
      const warmLookupMs = [];
      for (let iteration = 0; iteration < 3; iteration++) {
        const lookup = await elapsed(() => warmCache.lookupRecorded(recorded));
        assert.equal(lookup.value.cached?.outcome.kind, "usable-recorded-context");
        assert.equal(lookup.value.cached?.freshness, "unverified");
        warmLookupMs.push(lookup.ms);
      }
      samples.push({
        attempts,
        contractDigest: outcome.contract.digest,
        contextDigest: queryContractDigest(outcome.contract.context),
        canonicalContractBytes: Buffer.byteLength(serializeQueryContract(outcome.contract)),
        nativeEvidenceBytes: Buffer.byteLength(JSON.stringify(outcome.contract.nativeEvidence)),
        valuePlanBytes: Buffer.byteLength(JSON.stringify(outcome.contract.valuePlan)),
        durable: await fileBytes(closure),
        cache: await fileBytes(cacheOptions.directory),
        durableExportMs: exported.ms,
        durableReloadMs: loaded.ms,
        cachePublishMs: published.ms,
        coldCacheObjectLookupMs: cold.ms,
        warmLookupMs,
      });
    }
    const report = {
      formatVersion: 1,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      toolDigest: createHash("sha256")
        .update(await readFile(new URL(import.meta.url)))
        .digest("hex"),
      label: input.label,
      serverVersion: input.serverVersion,
      grammar: input.adapter.grammar,
      adapter: { id: input.adapter.id, version: input.adapter.version },
      sqlDigest: exactSqlDigest(input.candidate.sql),
      parameterOccurrences: input.candidate.parameterOccurrences.length,
      fixtureSchema: {
        bytes: Buffer.byteLength(serializeSchemaSnapshot(input.schema)),
        scope: "Owner-fixture compiler input; not a complete server catalog or application workload",
      },
      environment: { node: process.version, platform: process.platform, architecture: process.arch },
      method: {
        scope:
          "Three actual acquisitions of an existing owner-qualified fixture; not an application corpus, popularity sample or latency service-level guarantee.",
        acquisition:
          "Fresh context inspection, offline analysis, native acquisition and reconciliation measured separately. Up to three bounded attempts; stale attempts remain in the report. No candidate execution or application-value sampling.",
        bytes:
          "Canonical contract, native evidence and plan serialization plus actual exported one-query closure and disposable cache file contents. Filesystem blocks, install payloads and connection credentials are excluded.",
        cache:
          "Cold lookup opens a new cache object against existing files; warm lookups reuse an object. Neither drops OS page caches or claims current remote freshness. All recorded lookups must remain unverified.",
        environment:
          "Owner fixtures may already have warmed driver/server state; SDK ownership and transport boundaries remain adapter-specific. Compare only the declared environment, not engines as universal performance rankings.",
      },
      samples,
    };
    const staged = join(temporary, "report.json");
    await writeFile(staged, `${JSON.stringify(report, null, 2)}\n`);
    await rename(staged, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
