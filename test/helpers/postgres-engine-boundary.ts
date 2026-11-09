import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { acquireNativeQueryContract } from "../../packages/analysis/src/index.js";
import {
  createPgNativeContractAdapter,
  PostgresContractAcquisitionError,
} from "../../packages/postgres/src/pg-contracts.js";

async function stable<Value>(work: () => Promise<Value>): Promise<Value> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof PostgresContractAcquisitionError) || error.reason !== "context-changed" || attempt >= 2)
        throw error;
    }
  }
}

/** Read-only inspection of caller-provided qualification databases; no candidate execution. */
export async function auditPostgresEngineBoundaries(connectionStrings: readonly string[]) {
  assert.ok(connectionStrings.length >= 2 && connectionStrings.length <= 8);
  const pools: Pool[] = [],
    failures: unknown[] = [];
  const profiles: { version: string; versionNumber: number; ownAcquired: boolean }[] = [];
  const boundaries: { from: number; to: number; outcome: "context-mismatch" }[] = [];
  const report = {
    formatVersion: 1,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    toolDigest: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    method:
      "Distinct actual qualified engine versions with the same empty compiler schema and decoder policy. Every directed pair rejects the old native context; every target still acquires its own context. Candidates are never bound or executed. Endpoint/catalog identities can also differ; this does not isolate the version field or certify an in-place upgrade.",
    caseStatus: "incomplete",
    cleanupStatus: "pending",
    profiles,
    boundaries,
  };
  try {
    const schema = { formatVersion: 1 as const, dialect: "postgres" as const, tables: {} };
    const candidate = { sql: "SELECT 1 AS value", parameterOccurrences: [] };
    const targets = [];
    for (const connectionString of connectionStrings) {
      assert.ok(["postgres:", "postgresql:"].includes(new URL(connectionString).protocol));
      const pool = new Pool({ connectionString, max: 1 });
      pools.push(pool);
      const row = (
        await pool.query<{ version: string; number: string }>(
          "SELECT current_setting('server_version') AS version,current_setting('server_version_num') AS number",
        )
      ).rows[0]!;
      const versionNumber = Number(row.number);
      assert.ok(Number.isSafeInteger(versionNumber) && versionNumber > 0);
      const adapter = createPgNativeContractAdapter({ pool, schema });
      const context = await stable(() => adapter.inspectContext());
      assert.equal(
        (await stable(() => acquireNativeQueryContract({ adapter, context, candidate }))).status,
        "acquired",
      );
      profiles.push({ version: row.version, versionNumber, ownAcquired: true });
      targets.push({ adapter, context, versionNumber });
    }
    assert.equal(
      new Set(targets.map(({ versionNumber }) => versionNumber)).size,
      targets.length,
      "Every target must be a distinct actual engine version",
    );
    for (const from of targets)
      for (const to of targets) {
        if (from === to) continue;
        assert.deepEqual(from.context.grammar, to.context.grammar);
        assert.equal(from.context.schemaHash, to.context.schemaHash);
        assert.equal(from.context.typePolicyHash, to.context.typePolicyHash);
        assert.equal(from.context.codecHash, to.context.codecHash);
        assert.notEqual(from.context.databaseContextHash, to.context.databaseContextHash);
        assert.deepEqual(
          await stable(() => acquireNativeQueryContract({ adapter: to.adapter, context: from.context, candidate })),
          { status: "unavailable", reason: "context-mismatch" },
        );
        assert.equal(
          (await stable(() => acquireNativeQueryContract({ adapter: to.adapter, context: to.context, candidate })))
            .status,
          "acquired",
        );
        boundaries.push({ from: from.versionNumber, to: to.versionNumber, outcome: "context-mismatch" });
      }
    assert.equal(boundaries.length, targets.length * (targets.length - 1));
    report.caseStatus = "passed";
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled(pools.map((pool) => pool.end()));
  report.cleanupStatus = cleanup.every(({ status }) => status === "fulfilled") ? "passed" : "failed";
  for (const result of cleanup) if (result.status === "rejected") failures.push(result.reason);
  const output = resolve(
    process.env.TYPED_SQL_POSTGRES_ENGINE_BOUNDARY_OUTPUT ?? "artifacts/postgres/engine-boundary.json",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length)
    throw new AggregateError(failures, "PostgreSQL engine boundary or owned connection cleanup failed");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const uris: unknown = JSON.parse(process.env.TYPED_SQL_POSTGRES_ENGINE_URIS ?? "[]");
  assert.ok(Array.isArray(uris) && uris.every((uri): uri is string => typeof uri === "string"));
  const report = await auditPostgresEngineBoundaries(uris);
  console.log(
    JSON.stringify({ profiles: report.profiles, boundaries: report.boundaries, cleanupStatus: report.cleanupStatus }),
  );
}
