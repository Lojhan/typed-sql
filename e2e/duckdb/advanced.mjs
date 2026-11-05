import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compileSqlFile } from "@typed-sql/compiler";
import { requireAdapterCapability } from "@typed-sql/core";
import { duckdbAppender } from "@typed-sql/duckdb/runtime";
export async function advanced(db, compile, snapshot, grammar, row, engine) {
  const append = await compile("append", "INSERT INTO ingest(id,profile) VALUES(:id,:profile)", snapshot);
  const appender = requireAdapterCapability(db, duckdbAppender),
    progress = [];
  assert.deepEqual(
    await appender.append(
      append,
      [
        { id: 6n, profile: row.profile },
        { id: 7n, profile: row.profile },
      ],
      { chunkRows: 1, onProgress: (value) => progress.push(value) },
    ),
    { rows: 2, chunks: 2 },
  );
  assert.deepEqual(progress, [
    { rows: 1, chunks: 1 },
    { rows: 2, chunks: 2 },
  ]);
  assert.deepEqual(
    await db.queryable.all("SELECT id,doubled,label,profile FROM ingest ORDER BY id"),
    [6n, 7n].map((id) => ({ id, doubled: id * 2n, label: "default", profile: row.profile })),
  );
  await assert.rejects(
    appender.append(append, [
      { id: 8n, profile: row.profile },
      { id: 8n, profile: row.profile },
    ]),
  );
  await assert.rejects(
    appender.append(
      append,
      (async function* () {
        yield { id: 9n, profile: row.profile };
        throw new Error("packed producer failure");
      })(),
      { chunkRows: 1 },
    ),
    /packed producer failure/u,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await requireAdapterCapability(tx, duckdbAppender).append(append, [{ id: 10n, profile: row.profile }]);
      throw new Error("packed append rollback");
    }),
    /packed append rollback/u,
  );
  assert.deepEqual(await db.queryable.all("SELECT id FROM ingest ORDER BY id"), [{ id: 6n }, { id: 7n }]);
  const sql = "SELECT id,amount FROM records WHERE id=$1",
    fingerprint = `sha256:${createHash("sha256").update(sql).digest("hex")}`;
  assert.equal((await db.liveVerifier.server()).version, engine);
  const evidence = await db.liveVerifier.verify({ fingerprint, sql, operation: "read" });
  assert.deepEqual(
    evidence.columns.map((column) => [column.name, column.databaseType]),
    [
      ["id", "BIGINT"],
      ["amount", "DECIMAL(38,10)"],
    ],
  );
  assert.deepEqual(
    evidence.parameters.map((parameter) => parameter.databaseType),
    ["BIGINT"],
  );
  const environment = await db.planInspector.environment();
  assert.equal(environment.version, engine);
  assert.match(environment.statisticsFingerprint, /^sha256:[a-f\d]{64}$/u);
  for (const [source, values, operation] of [
    [sql, [row.id], "read"],
    ["INSERT INTO ingest(id,profile) VALUES($1,$2)", [99n, row.profile], "write"],
  ]) {
    const plan = await db.planInspector.capture({
      fingerprint,
      sql: source,
      operation,
      parameterCount: values.length,
      values,
    });
    assert.ok(plan.nodes.length > 0);
    assert.ok(!JSON.stringify(plan).includes(row.profile.label));
  }
  assert.deepEqual(await db.queryable.all("SELECT id FROM ingest WHERE id=99"), []);
  const shapes = [
    ["UNION(n INTEGER,s VARCHAR)", { tag: "n", value: null }],
    ["STRUCT(choice UNION(n INTEGER,s VARCHAR))", { choice: { tag: "n", value: null } }],
    ["MAP(INTEGER,UNION(n INTEGER,s VARCHAR))", [[1, { tag: "n", value: null }]]],
    ["UNION(n INTEGER,s VARCHAR)[2]", [{ tag: "n", value: null }, null]],
  ];
  for (const [index, [type, value]] of shapes.entries()) {
    const source = `SELECT CAST(:value AS ${type})`,
      rejected = compileSqlFile({ dialect: grammar, schema: snapshot, source });
    assert.ok(rejected.sourceDiagnostics.some((diagnostic) => diagnostic.message.includes("AS alias")));
    assert.match(rejected.text, /declare const query: never/u);
    const query = await compile(`shape-${index}`, `${source} AS document`, snapshot),
      cached = db.prepare(`shape-${index}`, query);
    assert.deepEqual(await db.one(cached({ value })), { document: value });
    assert.deepEqual(await db.one(cached({ value: null })), { document: null });
    assert.deepEqual(await db.one(cached({ value })), { document: value });
  }
  assert.deepEqual(
    await db.queryable.all(
      "SELECT table_name FROM duckdb_tables() WHERE temporary AND table_name LIKE '__typed_sql_append_%'",
    ),
    [],
  );
  console.log(
    "packed native appender/defaults/generated columns, verifier, non-executing nested-sample plans and fail-closed/cached UNION projection labels passed",
  );
}
