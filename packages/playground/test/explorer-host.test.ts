import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, strict } from "poku";
import { startPlayground } from "../src/server.js";
import { fixture } from "./helpers/fixture.js";

await describe("read-only workspace explorer protocol", async () => {
  await it("keeps saved exploration lazy, authenticates refresh and reads recorded history without query execution", async () =>
    fixture(async (directory) => {
      await mkdir(join(directory, "migrations", "002_pending"), { recursive: true });
      await writeFile(
        join(directory, "migrations", "002_pending", "migration.json"),
        JSON.stringify({ formatVersion: 1, id: "002_pending", up: "up.sql" }),
      );
      await writeFile(
        join(directory, "migrations", "002_pending", "up.sql"),
        "alter table public.accounts add email text",
      );
      const calls = join(directory, "observation-calls.txt");
      await writeFile(calls, "");
      const empty = {
        formatVersion: 1,
        dialect: "postgres",
        serverMajor: "18",
        namespaces: ["public"],
        coverage: "complete",
        objects: {},
      };
      const catalog = { ...empty, objects: { accounts: { definitionHash: "b".repeat(64) } } };
      const history = {
        formatVersion: 1,
        applied: [
          { id: "001_initial", hash: "a".repeat(64), catalog, direction: "up", attemptId: "first", origin: "executed" },
        ],
        attempts: [
          {
            id: "first",
            migrationId: "001_initial",
            hash: "a".repeat(64),
            direction: "up",
            state: "applied",
            beforeCatalog: empty,
            expectedCatalog: catalog,
          },
        ],
      };
      await writeFile(
        join(directory, "typed-sql.config.mjs"),
        `
import {appendFile,readFile} from 'node:fs/promises';
import {postgres} from '@typed-sql/postgres';
export default {
 dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',projects:['tsconfig.json'],
 migrations:{directory:'migrations',targets:{}},
 playground:{readRoots:['playground'],writeRoots:['playground'],targets:{local:{classification:'test',expected:{database:'test'},
  connect:async()=>{await appendFile(${JSON.stringify(calls)},'connect\\n');return {
   identity:async()=>({database:'test',server:'test',adapter:'fixture',readOnly:true}),
   query:async()=>{throw new Error('Explorer must not execute queries')},
   database:async()=>{throw new Error('Explorer must not execute project code')},
   migrationHistory:async()=>{await appendFile(${JSON.stringify(calls)},'history\\n');return {
    state:'ready',database:(await readFile(${JSON.stringify(calls)},'utf8')).includes('wrong-target')?'other':'test',history:${JSON.stringify(history)},
    objects:[{key:'accounts',kind:'relation',namespace:'public',name:'accounts'}]
   }},close:async()=>{await appendFile(${JSON.stringify(calls)},'close\\n')}
  }}
 }}}
};
`,
      );
      const host = await startPlayground({ config: join(directory, "typed-sql.config.mjs"), target: "local" });
      const headers = { "x-typed-sql-session": host.token, "content-type": "application/json" };
      try {
        strict.equal((await fetch(`${host.origin}/api/explorer`)).status, 403);
        strict.equal(
          (
            await fetch(`${host.origin}/api/explorer/refresh`, {
              method: "POST",
              headers: { ...headers, origin: "https://attacker.example" },
              body: "{}",
            })
          ).status,
          403,
        );
        const before = await fetch(`${host.origin}/api/explorer`, { headers });
        strict.equal(before.status, 200);
        const saved = await before.json();
        strict.ok(saved.schema.objects.some((object: { name: string }) => object.name === "accounts"));
        strict.equal(await readFile(calls, "utf8"), "");
        strict.equal(
          saved.migrations.entries.find((entry: { id: string }) => entry.id === "002_pending").status,
          "unverified",
        );
        const refreshed = await fetch(`${host.origin}/api/explorer/refresh`, { method: "POST", headers, body: "{}" });
        strict.equal(refreshed.status, 200);
        const observed = await refreshed.json();
        strict.equal(observed.migrations.state, "ready");
        strict.equal(
          observed.migrations.entries.find((entry: { id: string }) => entry.id === "001_initial").status,
          "applied",
        );
        strict.equal(
          observed.migrations.entries.find((entry: { id: string }) => entry.id === "002_pending").status,
          "pending",
        );
        strict.match(await readFile(calls, "utf8"), /^connect\nhistory\nclose\n$/);
        const again = await fetch(`${host.origin}/api/explorer`, { headers });
        strict.equal(again.status, 200);
        strict.equal(await readFile(calls, "utf8"), "connect\nhistory\nclose\n");
        strict.equal((await (await fetch(`${host.origin}/api/state`, { headers })).json()).trusted, false);
        await writeFile(calls, "wrong-target\n");
        const mismatched = await fetch(`${host.origin}/api/explorer/refresh`, { method: "POST", headers, body: "{}" });
        strict.equal(mismatched.status, 200);
        const rejected = await mismatched.json();
        strict.equal(rejected.migrations.state, "failed");
        strict.ok(!rejected.migrations.entries.some((entry: { id: string }) => entry.id === "001_initial"));
        strict.match(await readFile(calls, "utf8"), /^wrong-target\nconnect\nhistory\nclose\n$/);
      } finally {
        await host.close();
      }
    }));
});
