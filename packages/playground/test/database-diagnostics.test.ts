import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { postgres } from "@typed-sql/postgres";
import { describe, it, strict } from "poku";
import { databaseDiagnostic, databaseErrorEvidence, postgresPosition } from "../src/database-diagnostics.js";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { analyzeSql } from "../src/sql.js";
import { validateWorkerEvent } from "../src/worker-protocol.js";
import { fixture, snapshot } from "./helpers/fixture.js";

await describe("source-bound database diagnostics", async () => {
  await it("maps PostgreSQL character positions through compiler SQL offsets, including Unicode and normalized bindings", () => {
    const source = "-- 😀\nselect id from public.accounts where id=:accountId and id=1";
    const analysis = analyzeSql(source, postgres(), postgres().validateSnapshot(snapshot), undefined);
    strict.deepEqual(analysis.compiled.sourceDiagnostics, []);
    const query = analysis.compiled.query!.query;
    strict.notEqual(query.sql, source);
    const position = Array.from(query.sql.slice(0, query.sql.lastIndexOf("id=1"))).length + 1;
    const diagnostic = databaseDiagnostic(
      { engine: "postgres", sqlState: "42703", position },
      {
        file: "playground/query.sql",
        sourceRevision: contentHash(source),
        mode: "sql",
        source,
        sql: query.sql,
        offsets: query.sqlOffsetMap,
      },
    );
    strict.equal(diagnostic.range?.start, source.lastIndexOf("id=1"));
    strict.equal(diagnostic.range?.end, source.lastIndexOf("id=1") + 1);
    strict.equal(diagnostic.range?.line, 2);
    strict.equal(diagnostic.sourceRevision, contentHash(source));
    strict.equal(diagnostic.code, "PG42703");
    strict.equal(diagnostic.databasePosition, position);
  });
  await it("does not invent TS, connection, missing or invalid-map source locations", () => {
    const source = "select 1",
      offsets = Array.from({ length: source.length }, (_, index) => index),
      capture = { file: "q.sql", sourceRevision: "revision", mode: "sql", source, sql: source, offsets };
    strict.equal(databaseDiagnostic({ engine: "postgres", sqlState: "08006", position: 2 }, capture).range, undefined);
    strict.equal(databaseDiagnostic({ engine: "postgres", sqlState: "57P01", position: 2 }, capture).range, undefined);
    strict.equal(databaseDiagnostic({ engine: "postgres", sqlState: "42601" }, capture).range, undefined);
    strict.equal(
      databaseDiagnostic(
        { engine: "postgres", sqlState: "42601", position: 2 },
        { ...capture, mode: "file", file: "q.ts" },
      ).range,
      undefined,
    );
    strict.equal(databaseDiagnostic({ engine: "postgres", sqlState: "42601", position: 99 }, capture).range, undefined);
    strict.equal(
      databaseDiagnostic({ engine: "postgres", sqlState: "42601", position: 2 }, { ...capture, offsets: [0] }).range,
      undefined,
    );
    strict.equal(
      databaseDiagnostic({ engine: "postgres", sqlState: "42601", position: source.length + 1 }, capture).range?.start,
      source.length,
    );
    const emoji = "😀";
    strict.deepEqual(
      databaseDiagnostic(
        { engine: "postgres", sqlState: "42601", position: 1 },
        { ...capture, source: emoji, sql: emoji, offsets: [0, 1] },
      ).range,
      { start: 0, end: 2, line: 1, column: 1 },
    );
  });
  await it("validates safe metadata and rejects forged IPC shapes without copying driver details", () => {
    strict.equal(postgresPosition("12"), 12);
    for (const value of ["0", "-1", "1.5", Infinity, 0, {}, "private-data"])
      strict.equal(postgresPosition(value), undefined);
    const error = Object.assign(new Error("private driver message"), {
      name: "PlaygroundPgError",
      sqlState: "42601",
      position: 4,
      detail: "private",
      internalPosition: "2",
      internalQuery: "private",
    });
    strict.deepEqual(databaseErrorEvidence(error), { engine: "postgres", sqlState: "42601", position: 4 });
    strict.deepEqual(databaseErrorEvidence(Object.assign(error, { sqlState: "08006" })), {
      engine: "postgres",
      sqlState: "08006",
    });
    const event = {
      type: "error",
      code: "EXECUTION",
      message: "safe",
      database: { engine: "postgres", sqlState: "42601", position: 4, detail: "private" },
    };
    strict.deepEqual(validateWorkerEvent(event, 1000), {
      type: "error",
      code: "EXECUTION",
      message: "safe",
      database: { engine: "postgres", sqlState: "42601", position: 4 },
    });
    for (const database of [
      { engine: "postgres", sqlState: "private" },
      { engine: "postgres", sqlState: "42601", position: -1 },
      { engine: "postgres", sqlState: "42601", position: "4" },
    ])
      strict.throws(() => validateWorkerEvent({ ...event, database }, 1000), /database/iu);
  });
  await it("preserves safe SQLSTATE and exact revision-bound evidence through a real execution worker", async () =>
    fixture(async (directory) => {
      const config = join(directory, "typed-sql.config.mjs"),
        original = await readFile(config, "utf8");
      await writeFile(
        config,
        original.replace(
          "query:async request=>({columns:[{name:'id'}],rows:[[request.values[0]??42]],truncated:false})",
          `query:async request=>{const error=new Error('private driver detail');error.name='PlaygroundPgError';error.sqlState='42703';error.position=Array.from(request.text.slice(0,request.text.lastIndexOf('id=1'))).length+1;throw error}`,
        ),
      );
      const source = "-- 😀\nselect id from public.accounts where id=:accountId and id=1";
      await writeFile(join(directory, "playground/query.sql"), source);
      const manager = new RunManager(
        await loadConfig({ file: config }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        { timeoutMs: 5000, maxRows: 5, maxResultBytes: 100000, maxConsoleBytes: 100000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      try {
        const run = manager.start({
          requestId: "database-source-evidence",
          file: "playground/query.sql",
          revision: contentHash(source),
          mode: "sql",
          readOnly: true,
          values: [1],
        });
        const deadline = Date.now() + 15000;
        while (!run.finishedAt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        strict.equal(run.status, "failed", JSON.stringify(run));
        strict.equal(run.diagnostics.length, 1);
        const diagnostic = run.diagnostics[0]!;
        strict.equal(diagnostic.sourceRevision, contentHash(source));
        strict.equal(diagnostic.range?.start, source.lastIndexOf("id=1"));
        strict.equal(diagnostic.sqlState, "42703");
        strict.ok(!JSON.stringify({ diagnostic, error: run.error }).includes("private driver detail"));
      } finally {
        await manager.close();
      }
    }));
});
