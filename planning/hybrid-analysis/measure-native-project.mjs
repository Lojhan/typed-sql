import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
  acquireNativeQueryContract,
  createContractDialect,
  createStaticQueryClaim,
  exportQueryContracts,
  loadQueryContracts,
  openAnalysisCache,
  queryContractDigest,
  reconcileQueryContract,
} from "../../packages/analysis/src/index.ts";
import { collectSourceQueryCandidates, collectSqlFileQueryCandidates } from "../../packages/compiler/src/index.ts";
import { calculateSchemaHash, serializeSchemaSnapshot } from "../../packages/schema/src/index.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const sizes = (value) => ({
  bytes: Buffer.byteLength(value),
  gzipBytes: gzipSync(value, { level: 9 }).length,
  brotliBytes: brotliCompressSync(value, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
async function diskBytes(directory) {
  let bytes = 0,
    files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await diskBytes(path);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await readFile(path)).length;
      files++;
    } else throw Error("Unexpected native project artifact entry");
  }
  return { bytes, files };
}

/** Explicit native measurement; callers own fixture provisioning and target disconnection. */
export async function measureNativeProject(input) {
  assert.equal(input.profile.id, input.adapter.grammar.id);
  assert.equal(input.profile.grammarVersion, input.adapter.grammar.version);
  assert.equal(input.schema.formatVersion, 2, "Use an actual versioned introspection snapshot");
  const scales = input.scales ?? [1, 10, 50];
  assert.ok(
    scales.length &&
      new Set(scales).size === scales.length &&
      scales.every((value) => Number.isSafeInteger(value) && value > 0),
  );
  const base = [],
    excluded = [];
  for (const [file, source] of Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.startsWith("queries/") || !/\.(?:ts|sql)$/u.test(file)) continue;
    const collection = (file.endsWith(".sql") ? collectSqlFileQueryCandidates : collectSourceQueryCandidates)({
      source,
      schema: input.schema,
      profile: input.profile,
    });
    if (!collection.complete) {
      excluded.push({ file, diagnostics: collection.diagnostics });
      continue;
    }
    assert.ok(!collection.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
    for (const [index, candidate] of collection.candidates.entries()) base.push({ file, index, candidate });
  }
  assert.ok(base.length && scales.every((copies) => copies * base.length <= 4096));
  const temporary = await mkdtemp(join(tmpdir(), "typed-sql-native-project-"));
  let acquisitions = 0,
    inspections = 0;
  const adapter = {
    ...input.adapter,
    async open(signal) {
      acquisitions++;
      return input.adapter.open(signal);
    },
  };
  const evidenceObservations = {};
  const observations = [],
    offlineChecks = [];
  try {
    for (const copies of scales) {
      const started = performance.now();
      const beforeInspection = performance.now();
      const contextAttempts = [];
      let context;
      for (let attempt = 0; attempt < 3; attempt++) {
        inspections++;
        try {
          context = await input.adapter.inspectContext();
          contextAttempts.push({ attempt, status: "observed" });
          break;
        } catch (error) {
          contextAttempts.push({ attempt, status: error.reason ?? "failed" });
          if (error.reason !== "context-changed" || attempt === 2) throw error;
        }
      }
      assert.ok(context);
      const contextInspectionMs = performance.now() - beforeInspection;
      assert.equal(context.schemaHash, calculateSchemaHash(input.schema));
      const cacheDirectory = join(temporary, `cache-${copies}`);
      const cacheOptions = {
        directory: cacheDirectory,
        workspaceContext: queryContractDigest({ label: input.label, copies }),
      };
      const cache = await openAnalysisCache(cacheOptions);
      const contracts = [],
        recorded = [],
        queries = [],
        plans = [];
      const counts = {};
      let acquisitionMs = 0,
        reconciliationMs = 0,
        admitted = 0;
      for (let copy = 0; copy < copies; copy++) {
        const prefix = copy === 0 ? "" : `/* native workload copy ${copy} */\n`;
        for (const entry of base) {
          const candidate = {
            sql: prefix + entry.candidate.sql,
            parameterOccurrences: entry.candidate.parameterOccurrences.map((occurrence) => ({
              ...occurrence,
              start: occurrence.start + prefix.length,
              end: occurrence.end + prefix.length,
            })),
          };
          const admission = adapter.accept(candidate);
          const row = {
            file: entry.file,
            index: entry.index,
            sqlDigest: hash(candidate.sql),
            logicalBindings: entry.candidate.logicalBindings,
            logicalParameterCount: entry.candidate.logicalParameterCount,
            admission,
            status: "declined",
          };
          if (admission.accepted) {
            admitted++;
            const request = {
              adapter: { id: adapter.id, version: adapter.version },
              candidate,
              connectionContext: queryContractDigest({ target: "owned-commerce-native-project", label: input.label }),
              staticClaim: createStaticQueryClaim({
                sql: candidate.sql,
                context,
                analysis: input.analyze(candidate.sql),
              }),
              policy: input.policy,
            };
            let acquired;
            const beforeAcquisition = performance.now();
            try {
              acquired = await acquireNativeQueryContract({ adapter, candidate, context });
            } catch (error) {
              const failure = adapter.classifyError?.(error);
              if (!failure) throw error;
              row.status = failure.kind;
              row.failureCode = failure.code;
            }
            acquisitionMs += performance.now() - beforeAcquisition;
            if (acquired?.status === "acquired") {
              const beforeReconciliation = performance.now();
              const result = reconcileQueryContract({
                nativeContract: acquired.contract,
                staticClaim: request.staticClaim,
                contribution: input.contribution,
                policy: input.policy,
              });
              reconciliationMs += performance.now() - beforeReconciliation;
              row.status = result.status;
              if (copy === 0) {
                const evidence = { nativeEvidence: acquired.contract.nativeEvidence, qualification: result.report };
                row.evidenceDigest = queryContractDigest(evidence);
                evidenceObservations[row.evidenceDigest] = evidence;
              }
              if (result.status === "qualified") {
                const outcome = { kind: "usable-recorded-context", contract: result.contract };
                const token = (await cache.lookup(request)).token;
                assert.equal((await cache.publish({ token, request, outcome })).status, "published");
                contracts.push(result.contract);
                plans.push(result.contract.valuePlan);
                recorded.push({ request, digest: result.contract.digest });
                offlineChecks.push({ sql: candidate.sql, contract: result.contract, copies });
              }
            } else if (acquired) {
              row.status = acquired.status;
              row.failureCode = acquired.reason;
            }
          }
          counts[row.status] = (counts[row.status] ?? 0) + 1;
          if (copy === 0) queries.push(row);
        }
      }
      const closure = join(temporary, `contracts-${copies}`);
      await exportQueryContracts(closure, contracts);
      const observation = {
        copies,
        finiteCandidates: base.length * copies,
        admitted,
        qualified: contracts.length,
        counts,
        admittedSubsetComplete: admitted > 0 && admitted === contracts.length,
        completeProject: excluded.length === 0 && contracts.length === base.length * copies,
        contextInspectionMs,
        contextAttempts,
        acquisitionMs,
        reconciliationMs,
        acquisitionAndPublicationMs: performance.now() - started,
        valuePlans: sizes(JSON.stringify(plans)),
        durable: await diskBytes(closure),
        cache: await diskBytes(cacheDirectory),
        queries,
      };
      observations.push(observation);
      observation.offline = { closure, cacheOptions, recorded, context };
    }
    // The owner can remove its database here. Everything below uses only durable/cache inputs.
    await input.beforeOffline?.();
    const capturedAcquisitions = acquisitions,
      capturedInspections = inspections;
    for (const observation of observations) {
      const { closure, cacheOptions, recorded, context } = observation.offline;
      const started = performance.now();
      const contracts = await loadQueryContracts(closure);
      assert.deepEqual(contracts.map((contract) => contract.digest).sort(), recorded.map((item) => item.digest).sort());
      const dialect = createContractDialect({ profile: input.profile, context, contracts });
      for (const check of offlineChecks.filter((check) => check.copies === observation.copies)) {
        const analysis = dialect.analyze(check.sql, input.schema);
        assert.ok(!analysis.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
        assert.equal(analysis.columns.length, check.contract.valuePlan.columns.length);
        assert.equal(analysis.parameters.length, check.contract.valuePlan.parameters.length);
        assert.deepEqual(
          analysis.columns.map(({ name, runtimeType, nullable }) => ({ name, type: runtimeType, nullable })),
          check.contract.valuePlan.columns.map(({ name, type, nullable }) => ({ name, type, nullable })),
        );
        assert.deepEqual(
          analysis.parameters.map(({ index, runtimeType, nullable }) => ({ index, type: runtimeType, nullable })),
          check.contract.valuePlan.parameters.map(({ index, type, nullable }) => ({ index, type, nullable })),
        );
      }
      const cache = await openAnalysisCache(cacheOptions);
      for (const { request, digest } of recorded) {
        const selected = await cache.lookupRecorded({
          candidate: request.candidate,
          context,
          adapter: request.adapter,
          connectionContext: request.connectionContext,
          policy: request.policy,
        });
        assert.equal(selected.cached?.outcome.kind, "usable-recorded-context");
        assert.equal(selected.cached?.outcome.contract.digest, digest);
        assert.equal(selected.cached?.freshness, "unverified");
      }
      observation.offlineReloadAndCheckMs = performance.now() - started;
      delete observation.offline;
    }
    assert.equal(acquisitions, capturedAcquisitions);
    assert.equal(inspections, capturedInspections);
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const fixturePath = fileURLToPath(input.fixtureProducer);
    const fixtureRelativePath = relative(root, fixturePath).split(sep).join("/");
    assert.ok(fixtureRelativePath.startsWith("planning/hybrid-analysis/"));
    return {
      formatVersion: 1,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      toolDigest: hash(await readFile(fileURLToPath(import.meta.url))),
      fixtureProducer: { path: fixtureRelativePath, digest: hash(await readFile(fixturePath)) },
      label: input.label,
      grammar: adapter.grammar,
      adapter: { id: adapter.id, version: adapter.version },
      server: input.schema.server,
      schema: sizes(serializeSchemaSnapshot(input.schema)),
      schemaHash: calculateSchemaHash(input.schema),
      corpusInputs: Object.fromEntries(Object.entries(input.files).map(([file, source]) => [file, hash(source)])),
      policy: input.policy,
      excluded,
      environment: { node: process.version, platform: process.platform, architecture: process.arch },
      method:
        "Actual native acquisition and independent reconciliation of the maintained commerce corpus. Copy zero is unchanged; later copies add comments only, stressing exact-SQL identity. No candidate is bound, stepped or supplied sample values. Durables/cache measure only qualified admitted subsets, not a complete application. Counts are API acquisitions/context inspections, not protocol round trips. Acquisition/publication time excludes fixture provisioning, introspection, compression, artifact byte reads and offline replay. Offline reload retains unverified freshness. Compression uses gzip level 9 and Brotli quality 11. Measurements are single observations per scale, not latency percentiles or production popularity or full CLI/build timing.",
      evidenceObservations,
      acquisitions,
      inspections,
      offlineNativeCalls: 0,
      observations,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
