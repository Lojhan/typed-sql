import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { describe, it, skip, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { createPgPlaygroundTarget, PlaygroundPgError } from "../src/pg.js";
import { RunManager } from "../src/runner.js";
import { fixture } from "./helpers/fixture.js";

const connectionString = process.env.TYPED_SQL_PLAYGROUND_PG_URL;
if (!connectionString) skip("Set TYPED_SQL_PLAYGROUND_PG_URL for actual PostgreSQL diagnostic evidence");
await describe("real PostgreSQL source diagnostics", async () => {
  await it("preserves external PostgreSQL character position without server message or data", async () => {
    const target = createPgPlaygroundTarget({ connectionString: connectionString! });
    const text = "-- 😀\nselect 'bad'::int4 as value;";
    try {
      await strict.rejects(
        target.query({
          text,
          values: [],
          readOnly: true,
          maxRows: 1,
          timeoutMs: 3000,
          signal: new AbortController().signal,
        }),
        (error: unknown) =>
          error instanceof PlaygroundPgError &&
          error.sqlState === "22P02" &&
          error.queryHash === contentHash(text) &&
          error.position === Array.from(text.slice(0, text.indexOf("'bad'"))).length + 1 &&
          !error.message.includes("bad"),
      );
    } finally {
      await target.close();
    }
  });
  await it("carries actual PostgreSQL metadata through the worker to the original Unicode SQL buffer", async () =>
    fixture(async (directory) => {
      await writeFile(
        join(directory, "typed-sql.config.mjs"),
        `import { postgres } from '@typed-sql/postgres/analysis';import {createPgPlaygroundTarget} from '@typed-sql/playground/pg';export default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{readRoots:['playground'],writeRoots:['playground'],targets:{local:{classification:'test',connect:()=>createPgPlaygroundTarget({connectionString:process.env.TYPED_SQL_PLAYGROUND_PG_URL})}}}};`,
      );
      const source = "-- 😀\nselect 'bad'::int4 as value;";
      await writeFile(join(directory, "playground/error.sql"), source);
      const manager = new RunManager(
        await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
        new WorkspaceFiles(directory, ["playground"], ["playground"]),
        { timeoutMs: 5000, maxRows: 5, maxResultBytes: 100000, maxConsoleBytes: 100000 },
        "local",
        join(directory, "tsconfig.json"),
      );
      try {
        const run = manager.start({
          requestId: "real-pg-source-diagnostic",
          file: "playground/error.sql",
          revision: contentHash(source),
          mode: "sql",
          readOnly: true,
        });
        const deadline = Date.now() + 15000;
        while (!run.finishedAt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        strict.equal(run.status, "failed", JSON.stringify(run));
        strict.equal(run.diagnostics[0]?.sqlState, "22P02");
        strict.equal(run.diagnostics[0]?.range?.start, source.indexOf("'bad'"));
        strict.equal(run.diagnostics[0]?.sourceRevision, contentHash(source));
        strict.ok(!JSON.stringify(run.diagnostics).includes("'bad'"));
      } finally {
        await manager.close();
      }
    }));
});
