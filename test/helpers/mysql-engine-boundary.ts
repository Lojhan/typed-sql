import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Connection, createConnection } from "mysql2/promise";
import { acquireNativeQueryContract } from "../../packages/analysis/src/index.js";
import { mysql2 } from "../../packages/mysql/src/mysql2.js";
import {
  createMySql2NativeContractAdapter,
  MySqlContractAcquisitionError,
} from "../../packages/mysql/src/mysql2-contracts.js";
import { MYSQL_SUPPORT_POLICY } from "../../packages/mysql/src/support.js";

/** Actual endpoint changes, not simulated versions or a claim about in-place database upgrades. */
export async function auditMySqlEngineBoundaries(connectionUris: readonly string[]) {
  assert.equal(connectionUris.length, MYSQL_SUPPORT_POLICY.stable.length);
  assert.ok(connectionUris.length >= 2);
  const owned: { connection: Connection; name: string; created: boolean }[] = [];
  const profiles: { engine: string; ownAcquired: boolean }[] = [];
  const boundaries: { from: string; to: string; oldEnvironmentRejected: boolean; oldContextRejected: boolean }[] = [];
  const failures: unknown[] = [];
  const report = {
    formatVersion: 1,
    method:
      "Actual distinct endpoints and owned empty databases. Each engine acquires its own context. Moving an old schema/context to the other engine fails native environment attestation; a fresh target adapter also rejects the prior context. No candidate is executed or bound to sample values. This is not an in-place upgrade or an engine-only isolation claim.",
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    toolDigest: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    caseStatus: "incomplete",
    cleanupStatus: "pending",
    profiles,
    boundaries,
  };
  try {
    const targets = [];
    const candidate = { sql: "SELECT 1 AS value", parameterOccurrences: [] };
    for (const connectionUri of connectionUris) {
      const uri = new URL(connectionUri);
      assert.equal(uri.protocol, "mysql:");
      const connection = await createConnection(connectionUri);
      const name = `typed_sql_engine_${randomBytes(8).toString("hex")}`;
      const owner = { connection, name, created: false };
      owned.push(owner);
      await connection.query(`CREATE DATABASE ${name}`);
      owner.created = true;
      uri.pathname = `/${name}`;
      const selectedUri = uri.href;
      const schema = await mysql2({ connectionUri: selectedUri }).introspect();
      assert.equal(schema.formatVersion, 2);
      if (schema.formatVersion !== 2) throw Error("Versioned MySQL environment required");
      const adapter = createMySql2NativeContractAdapter({ connectionUri: selectedUri, schema });
      const context = await adapter.inspectContext();
      assert.equal((await acquireNativeQueryContract({ adapter, context, candidate })).status, "acquired");
      profiles.push({ engine: schema.server.version, ownAcquired: true });
      targets.push({ engine: schema.server.version, uri: selectedUri, schema, adapter, context });
    }
    assert.deepEqual(
      targets.map(({ engine }) => engine).sort(),
      MYSQL_SUPPORT_POLICY.stable.map(({ matrixVersion }) => matrixVersion).sort(),
      "Supply every declared stable engine exactly once",
    );
    for (const from of targets)
      for (const to of targets) {
        if (from === to) continue;
        assert.notEqual(from.engine, to.engine);
        const moved = createMySql2NativeContractAdapter({ connectionUri: to.uri, schema: from.schema });
        const unsupported = (error: unknown) =>
          error instanceof MySqlContractAcquisitionError && error.reason === "unsupported-context";
        await assert.rejects(moved.inspectContext(), unsupported);
        await assert.rejects(
          acquireNativeQueryContract({ adapter: moved, context: from.context, candidate }),
          unsupported,
        );
        assert.deepEqual(await acquireNativeQueryContract({ adapter: to.adapter, context: from.context, candidate }), {
          status: "unavailable",
          reason: "context-mismatch",
        });
        assert.equal(
          (await acquireNativeQueryContract({ adapter: to.adapter, context: to.context, candidate })).status,
          "acquired",
        );
        boundaries.push({ from: from.engine, to: to.engine, oldEnvironmentRejected: true, oldContextRejected: true });
      }
    assert.equal(boundaries.length, targets.length * (targets.length - 1));
    report.caseStatus = "passed";
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled(
    owned.map(async ({ connection, name, created }) => {
      try {
        if (created) await connection.query(`DROP DATABASE ${name}`);
      } finally {
        await connection.end();
      }
    }),
  );
  report.cleanupStatus = cleanup.every(({ status }) => status === "fulfilled") ? "passed" : "failed";
  for (const result of cleanup) if (result.status === "rejected") failures.push(result.reason);
  const output = resolve(process.env.TYPED_SQL_MYSQL_ENGINE_BOUNDARY_OUTPUT ?? "artifacts/mysql/engine-boundary.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) throw new AggregateError(failures, "MySQL engine boundary or owned cleanup failed");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const uris: unknown = JSON.parse(process.env.TYPED_SQL_MYSQL_ENGINE_URIS ?? "[]");
  assert.ok(Array.isArray(uris) && uris.every((uri): uri is string => typeof uri === "string"));
  const report = await auditMySqlEngineBoundaries(uris);
  console.log(
    JSON.stringify({ profiles: report.profiles, boundaries: report.boundaries, cleanupStatus: report.cleanupStatus }),
  );
}
