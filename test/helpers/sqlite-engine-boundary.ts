import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireNativeQueryContract, type QueryContractContext } from "../../packages/analysis/src/index.js";
import { createNodeSqliteNativeContractAdapter } from "../../packages/sqlite/src/node-sqlite-contracts.js";

const run = promisify(execFile);
const producer = {
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  toolDigest: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
};
interface Capture {
  producer: typeof producer;
  node: string;
  sqliteVersion: string;
  sourceId: string;
  compileOptions: string[];
  engineFingerprint: string;
  context: QueryContractContext;
  ownContextAcquired: boolean;
  rejectedEngines: string[];
}
async function peer(path: string, destination: string, previous: string[]) {
  const database = new DatabaseSync(path, { readOnly: true });
  let version: string, sourceId: string, compileOptions: string[];
  try {
    const row = database.prepare("SELECT sqlite_version() AS version,sqlite_source_id() AS source").get()!;
    assert.ok(typeof row.version === "string" && typeof row.source === "string");
    version = row.version;
    sourceId = row.source;
    compileOptions = database
      .prepare("PRAGMA compile_options")
      .all()
      .map((row) => {
        assert.ok(typeof row.compile_options === "string");
        return row.compile_options;
      })
      .sort();
  } finally {
    database.close();
  }
  const engineFingerprint = createHash("sha256")
    .update(JSON.stringify({ version, sourceId, compileOptions }))
    .digest("hex");
  const schema = { formatVersion: 1 as const, dialect: "sqlite" as const, tables: {} };
  const candidate = { sql: "SELECT 1 AS value", parameterOccurrences: [] };
  const adapter = createNodeSqliteNativeContractAdapter({ path, schema });
  const context = await adapter.inspectContext();
  assert.equal((await acquireNativeQueryContract({ adapter, context, candidate })).status, "acquired");
  const rejectedEngines = [];
  for (const file of previous) {
    const before: Capture = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(before.producer, producer);
    assert.notEqual(before.engineFingerprint, engineFingerprint, "Use distinct actual SQLite builds");
    assert.deepEqual(before.context.grammar, context.grammar);
    assert.equal(before.context.schemaHash, context.schemaHash);
    assert.equal(before.context.typePolicyHash, context.typePolicyHash);
    assert.equal(before.context.codecHash, context.codecHash);
    assert.notEqual(before.context.databaseContextHash, context.databaseContextHash);
    assert.deepEqual(await acquireNativeQueryContract({ adapter, context: before.context, candidate }), {
      status: "unavailable",
      reason: "context-mismatch",
    });
    assert.equal((await acquireNativeQueryContract({ adapter, context, candidate })).status, "acquired");
    rejectedEngines.push(before.engineFingerprint);
  }
  const captured: Capture = {
    producer,
    node: process.version,
    sqliteVersion: version,
    sourceId,
    compileOptions,
    engineFingerprint,
    context,
    ownContextAcquired: true,
    rejectedEngines,
  };
  await writeFile(destination, `${JSON.stringify(captured, null, 2)}\n`);
}

async function audit(nodes: string[]) {
  assert.ok(nodes.length >= 2 && nodes.length <= 8);
  const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-engines-"));
  const failures: unknown[] = [],
    profiles: Capture[] = [];
  const report = {
    formatVersion: 1,
    ...producer,
    method:
      "Separate Node processes inspect the same immutable owned database file with identical compiler schema/policy. Each actual SQLite build acquires its own context and rejects every other build's context. No candidate is executed or bound to samples. This is not an in-place application upgrade test.",
    databaseDigest: undefined as string | undefined,
    caseStatus: "incomplete",
    cleanupStatus: "pending",
    profiles,
  };
  try {
    const path = join(directory, "fixture.sqlite");
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE boundary_fixture(value TEXT)");
    } finally {
      database.close();
    }
    report.databaseDigest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const files = nodes.map((_, index) => join(directory, `${index}.json`));
    const invoke = (node: string, index: number, previous: string[]) =>
      run(
        node,
        [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(import.meta.url),
          "--peer",
          path,
          files[index]!,
          ...previous,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
    for (const [index, node] of nodes.entries()) {
      await invoke(node, index, []);
      const captured: Capture = JSON.parse(await readFile(files[index]!, "utf8"));
      assert.deepEqual(captured.producer, producer);
      profiles.push(captured);
    }
    assert.equal(
      new Set(profiles.map(({ engineFingerprint }) => engineFingerprint)).size,
      nodes.length,
      "Every target must be a distinct actual SQLite build",
    );
    for (const [index, node] of nodes.entries()) {
      await invoke(
        node,
        index,
        files.filter((_, other) => other !== index),
      );
      const captured: Capture = JSON.parse(await readFile(files[index]!, "utf8"));
      assert.deepEqual(captured.producer, producer);
      assert.equal(captured.rejectedEngines.length, nodes.length - 1);
      profiles[index] = captured;
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      report.databaseDigest,
      "The owned database file must remain unchanged",
    );
    report.caseStatus = "passed";
  } catch (error) {
    failures.push(error);
  }
  try {
    await rm(directory, { recursive: true, force: true });
    report.cleanupStatus = "passed";
  } catch (error) {
    report.cleanupStatus = "failed";
    failures.push(error);
  }
  const output = resolve(
    process.env.TYPED_SQL_SQLITE_ENGINE_BOUNDARY_OUTPUT ?? "artifacts/sqlite/engine-boundary.json",
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) throw new AggregateError(failures, "SQLite engine boundary or owned cleanup failed");
  console.log(
    JSON.stringify({
      profiles: profiles.map(({ node, sqliteVersion, rejectedEngines }) => ({
        node,
        sqliteVersion,
        rejectedOtherBuilds: rejectedEngines.length,
      })),
      cleanupStatus: report.cleanupStatus,
    }),
  );
}
const [mode, ...args] = process.argv.slice(2);
if (mode === "--peer") {
  const [path, destination, ...previous] = args;
  assert.ok(path && destination);
  await peer(path, destination, previous);
} else await audit([mode!, ...args]);
