import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer, server, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer(["wrangler", "esbuild"], ["@typed-sql/adapters"]);
try {
  await describe("Wrangler custom build with D1", async () => {
    await it("runs a bundled Worker against local D1 without configuration or drivers in the deployed graph", async () => {
      const root = await fixture.project("worker");
      await writeEntry(root);
      await writeFile(
        join(root, "build.mjs"),
        'import {build} from "esbuild"; import {typedSql} from "@typed-sql/build/esbuild"; await build({entryPoints:["worker.ts"],outfile:"dist/worker.mjs",bundle:true,format:"esm",platform:"browser",target:"es2024",sourcemap:true,plugins:[typedSql()]});',
      );
      await writeFile(
        join(root, "worker.ts"),
        `import {createD1Database} from "@typed-sql/adapters/d1";
import {getQueryValuePlan} from "@typed-sql/core";
import {sqliteRenderer} from "@typed-sql/sqlite/query";
import {query,inline,repeated,conditional} from "./entry.ts";
export default { async fetch(_request,env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY,email TEXT NOT NULL) STRICT").run();
  await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO account VALUES (?,?)").bind(1,"a@example.com"),env.DB.prepare("INSERT OR IGNORE INTO account VALUES (?,?)").bind(2,"b@example.com")]);
  const plan=getQueryValuePlan(query(1));
  if(!plan || !getQueryValuePlan(inline(1))) throw new Error("Missing compiled query plans");
  const db=createD1Database(env.DB,{renderer:sqliteRenderer,profile:{id:"e2e-d1",dialect:"sqlite",integer:"safe-number",jsonWire:"text",typePolicyHash:plan.typePolicyHash}});
  return Response.json({file:await db.all(query(1)),inline:await db.all(inline(1)),repeated:await db.all(repeated([1,2])),conditional:await db.all(conditional(false))});
}};`,
      );
      await writeFile(
        join(root, "wrangler.jsonc"),
        JSON.stringify({
          name: "typed-sql-build-e2e",
          main: "dist/worker.mjs",
          compatibility_date: "2026-10-30",
          build: {
            command: "node build.mjs",
            watch_dir: ["entry.ts", "inline.ts", "query.sql", "schema.json", "typed-sql.config.mjs", "policy.mjs"],
          },
          d1_databases: [
            {
              binding: "DB",
              database_name: "typed-sql-build-e2e",
              database_id: "00000000-0000-0000-0000-000000000001",
            },
          ],
        }),
      );
      const environment = { CLOUDFLARE_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(root, "wrangler.log") };
      await fixture.command(root, "pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", "dry-run"], {
        env: environment,
      });
      const instance = await server(
        root,
        [
          join(fixture.directory, "node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          "{port}",
          "--persist-to",
          ".local-state",
        ],
        environment,
      );
      try {
        const response = await instance.fetch("/");
        assert.equal(response.status, 200, instance.output());
        const result = await response.json();
        const row = { id: 1, email: "a@example.com" };
        assert.deepEqual(result, {
          file: [row],
          inline: [row],
          repeated: [row, { id: 2, email: "b@example.com" }],
          conditional: [{ id: 1 }],
        });
      } finally {
        await instance.close();
      }
      await writeFile(join(root, "query.sql"), "SELECT nonexistent FROM account");
      const invalid = await fixture.command(root, "pnpm", ["exec", "wrangler", "deploy", "--dry-run"], {
        env: environment,
        allowFailure: true,
      });
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.output, /TSQ101.*Unknown column nonexistent/u);
    });
  });
} finally {
  await fixture.close();
}
