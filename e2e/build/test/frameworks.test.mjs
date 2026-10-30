import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { consumer, server, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer([
  "typescript-framework",
  "@types/node",
  "astro",
  "nuxt",
  "vue",
  "rolldown",
  "esbuild",
  "vite",
  "svelte",
  "@sveltejs/kit",
  "@sveltejs/vite-plugin-svelte",
  "@sveltejs/adapter-node",
]);
async function checkSqlImports(root) {
  await fixture.command(root, "pnpm", ["exec", "typed-sql-build", "types"]);
  const consumer = join(root, "query-consumer.ts");
  const valid =
    'import query from "./query.sql"; import type {Query} from "@typed-sql/core"; const checked:Query<{id:number;email:string},readonly [number]>=query(1); void checked;';
  await writeFile(consumer, valid);
  const compiler = join(fixture.directory, "node_modules/typescript-framework/bin/tsc");
  await fixture.command(root, process.execPath, [compiler, "--noEmit"]);
  await writeFile(consumer, 'import query from "./query.sql"; query("wrong");');
  const invalid = await fixture.command(root, process.execPath, [compiler, "--noEmit"], { allowFailure: true });
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.output, /string.*not assignable.*number/u);
  await writeFile(consumer, valid);
}
try {
  await describe("Framework installation recipes", async () => {
    await it("Astro's server-side page imports compiled TypeScript query modules", async () => {
      const root = await fixture.project("astro");
      await writeEntry(root);
      await checkSqlImports(root);
      await mkdir(join(root, "src/pages"), { recursive: true });
      await writeFile(
        join(root, "astro.config.mjs"),
        'import {defineConfig} from "astro/config"; import {typedSql} from "@typed-sql/build/vite"; export default defineConfig({vite:{plugins:[typedSql()]}});',
      );
      await writeFile(
        join(root, "src/pages/index.astro"),
        '---\nimport * as queries from "../../entry.ts"; import {verify} from "../../verify.mjs"; await verify(queries);\n---\n<html><body>compiled queries executed</body></html>',
      );
      await fixture.command(root, "pnpm", ["exec", "astro", "build"], { env: { ASTRO_TELEMETRY_DISABLED: "1" } });
      assert.match(await readFile(join(root, "dist/index.html"), "utf8"), /compiled queries executed/u);
    });
    await it("Nuxt's Nitro server route compiles SQL separately from the app Vite graph", async () => {
      const root = await fixture.project("nuxt");
      await writeEntry(root);
      await checkSqlImports(root);
      await mkdir(join(root, "server/api"), { recursive: true });
      await writeFile(
        join(root, "nuxt.config.mjs"),
        'import {defineNuxtConfig} from "nuxt/config"; import {typedSql as viteSql} from "@typed-sql/build/vite"; import {typedSql as serverSql} from "@typed-sql/build/rollup"; export default defineNuxtConfig({devtools:{enabled:false},vite:{plugins:[viteSql({cwd:process.cwd()})]},nitro:{hooks:{"rollup:before"(_nitro,config){config.plugins.unshift(serverSql({cwd:process.cwd()}));}},externals:{external:["@typed-sql/core","@typed-sql/sqlite"]}}});',
      );
      await writeFile(
        join(root, "server/api/query.get.ts"),
        'import * as queries from "../../entry.ts"; import {verify} from "../../verify.mjs"; export default defineEventHandler(async()=>{await verify(queries); return {ok:true};});',
      );
      await fixture.command(root, "pnpm", ["exec", "nuxt", "build"], {
        timeout: 240_000,
        env: { NUXT_TELEMETRY_DISABLED: "1" },
      });
      const instance = await server(root, [".output/server/index.mjs"]);
      try {
        const response = await instance.fetch("/api/query");
        assert.equal(response.status, 200, instance.output());
        assert.deepEqual(await response.json(), { ok: true });
      } finally {
        await instance.close();
      }
    });
    await it("SvelteKit's Node adapter serves compiled queries from a server endpoint", async () => {
      const root = await fixture.project("sveltekit");
      await writeEntry(root);
      await checkSqlImports(root);
      await mkdir(join(root, "src/routes/api/query"), { recursive: true });
      await writeFile(
        join(root, "src/app.html"),
        "<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>",
      );
      await writeFile(
        join(root, "vite.config.mjs"),
        'import adapter from "@sveltejs/adapter-node"; import {defineConfig} from "vite"; import {sveltekit} from "@sveltejs/kit/vite"; import {typedSql} from "@typed-sql/build/vite"; export default defineConfig({plugins:[typedSql(),sveltekit({adapter:adapter()})]});',
      );
      await writeFile(
        join(root, "src/routes/api/query/+server.ts"),
        'import * as queries from "../../../../entry.ts"; import {verify} from "../../../../verify.mjs"; export async function GET(){await verify(queries); return Response.json({ok:true});}',
      );
      await fixture.command(root, "pnpm", ["exec", "vite", "build"], { timeout: 240_000 });
      const instance = await server(root, ["build/index.js"]);
      try {
        const response = await instance.fetch("/api/query");
        assert.equal(response.status, 200, instance.output());
        assert.deepEqual(await response.json(), { ok: true });
      } finally {
        await instance.close();
      }
    });
  });
} finally {
  await fixture.close();
}
