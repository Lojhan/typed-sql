import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@typed-sql/config";
import { loadPgDriver } from "@typed-sql/postgres/pg";
import { describe, it, skip, strict } from "poku";
import { contentHash, WorkspaceFiles } from "../src/files.js";
import { RunManager } from "../src/runner.js";
import { decodeValue } from "../src/values.js";
import { fixture } from "./helpers/fixture.js";

const connectionString = process.env.TYPED_SQL_PLAYGROUND_PG_URL;
if (!connectionString) skip("Set TYPED_SQL_PLAYGROUND_PG_URL for demand cursor integration");
const { Pool } = await loadPgDriver();
const pool = new Pool({ connectionString });
async function until(test: () => boolean) {
  const end = Date.now() + 20000;
  while (!test()) {
    if (Date.now() > end) throw new Error("Paging state did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  await describe("real demand-driven worker cursor", async () => {
    await it("pulls 1203 rows in order only on demand, retains pages and closes idle cursors", async () =>
      fixture(async (directory) => {
        const namespace = `page_${randomUUID().replaceAll("-", "")}`;
        await pool.query(`create schema "${namespace}"`);
        try {
          await pool.query(`create table "${namespace}".accounts(id integer not null,name text)`);
          await pool.query(`insert into "${namespace}".accounts select i,'name '||i from generate_series(1,1203) i`);
          await writeFile(
            join(directory, "schema.json"),
            JSON.stringify({
              formatVersion: 1,
              dialect: "postgres",
              tables: {
                [`${namespace}.accounts`]: {
                  name: "accounts",
                  schema: namespace,
                  columns: {
                    id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
                    name: { name: "name", databaseType: "text", tsType: "string", nullable: true },
                  },
                },
              },
            }),
          );
          const database = (await pool.query("select current_database() as name")).rows[0].name;
          await writeFile(
            join(directory, "typed-sql.config.mjs"),
            `import {postgres} from '@typed-sql/postgres';import {createPgPlaygroundTarget} from '@typed-sql/playground/pg';export default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],playground:{targets:{local:{classification:'test',expected:{database:${JSON.stringify(database)}},connect:()=>createPgPlaygroundTarget({connectionString:${JSON.stringify(connectionString)}})}}}}`,
          );
          const source = `select id,name from "${namespace}".accounts order by id`;
          await writeFile(join(directory, "playground/query.sql"), source);
          const manager = new RunManager(
            await loadConfig({ file: join(directory, "typed-sql.config.mjs") }),
            new WorkspaceFiles(directory, ["playground"], ["playground"]),
            { timeoutMs: 3000, pageSize: 137, maxResultBytes: 100_000, maxConsoleBytes: 100_000, cursorIdleMs: 1500 },
            "local",
            join(directory, "tsconfig.json"),
          );
          try {
            const start = (requestId: string) =>
              manager.start({ requestId, file: "playground/query.sql", revision: contentHash(source), mode: "sql" });
            const run = start("demand-paging-first");
            await until(() => run.results.length > 0 || run.finishedAt !== undefined);
            strict.equal(run.status, "running", JSON.stringify(run));
            const result = run.results[0]!;
            strict.equal(result.paging?.rowCount, 137);
            await new Promise((resolve) => setTimeout(resolve, 100));
            strict.equal(
              run.results[0]?.paging?.rowCount,
              137,
              "server does not fetch later rows without browser demand",
            );
            const ids: number[] = [];
            for (let page = 0; ; page++) {
              const response = (await manager.page(run.id, result.paging!.id, page)) as {
                value: Parameters<typeof decodeValue>[0];
                hasPage: boolean;
                nextPage: number | null;
              };
              if (response.hasPage)
                ids.push(...(decodeValue(response.value) as { rows: number[][] }).rows.map((row) => row[0]!));
              if (response.nextPage === null) break;
            }
            await until(() => run.finishedAt !== undefined);
            strict.equal(run.status, "succeeded", JSON.stringify(run));
            strict.deepEqual(
              ids,
              Array.from({ length: 1203 }, (_, i) => i + 1),
            );
            strict.equal(run.results[0]?.paging?.complete, true);
            strict.ok(typeof run.timings.fetchMs === "number");
            strict.ok(
              run.timings.fetchMs! < run.timings.workerMs!,
              "active query/fetch excludes worker setup and demand idle",
            );
            strict.equal(run.timings.databaseMs, null, "client timing never claims pure server duration");
            const closed = start("demand-paging-close");
            await until(() => closed.results.length > 0 || closed.finishedAt !== undefined);
            manager.closeResult(closed.id, closed.results[0]!.paging!.id);
            await until(() => closed.finishedAt !== undefined);
            strict.equal(closed.status, "cancelled", JSON.stringify(closed));
            strict.equal(closed.results[0]?.paging?.complete, false);
            const retained = (await manager.page(closed.id, closed.results[0]!.paging!.id, 0)) as {
              hasPage: boolean;
              nextPage: number | null;
            };
            strict.equal(retained.hasPage, true);
            strict.equal(
              retained.nextPage,
              null,
              "closed cursors retain evidence without advertising unavailable pages",
            );
            const expired = start("demand-paging-idle");
            await until(() => expired.results.length > 0 || expired.finishedAt !== undefined);
            await until(() => expired.finishedAt !== undefined);
            strict.equal(expired.status, "cancelled", JSON.stringify(expired));
          } finally {
            await manager.close();
          }
        } finally {
          await pool.query(`drop schema "${namespace}" cascade`);
        }
      }));
  });
} finally {
  await pool.end();
}
