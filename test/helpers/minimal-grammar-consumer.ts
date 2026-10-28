import { execFile as callback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { strict } from "poku";
import { prepareSqlFileConsumer } from "./sql-file-consumer.js";

const execFile = promisify(callback);

/** Reuses the existing tarballs, with only the grammar and frontend installed as direct dependencies. */
export async function assertMinimalGrammarConsumer(options: {
  consumer: string;
  directory: string;
  previewCli: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const manifest = JSON.parse(await readFile(join(options.consumer, "package.json"), "utf8"));
  await mkdir(options.directory);
  await writeFile(
    join(options.directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      pnpm: manifest.pnpm,
      dependencies: {
        "@typed-sql/postgres": manifest.dependencies["@typed-sql/postgres"],
        "@typed-sql/ts-bridge": manifest.dependencies["@typed-sql/ts-bridge"],
      },
    }),
  );
  await execFile("pnpm", ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], {
    cwd: options.directory,
    env: { ...options.env, CI: "true" },
  });
  const project = await prepareSqlFileConsumer(options.directory);
  await writeFile(
    join(project, "main.ts"),
    `import find from "./find.sql";
import type { Query } from "@typed-sql/postgres/query";
const query: Query<{ id: number; name: string }, readonly [number, string]> = find(7, "Ada");
// @ts-expect-error SQL parameters retain their inferred types
find("wrong", 7);
void query;`,
  );
  await execFile(process.execPath, [options.previewCli, "-p", project, "--runExternalCode", "--pretty", "false"], {
    cwd: project,
    env: options.env,
  });
  // Compile through the installed tooling package, then execute only in the minimal application's closure.
  const compileFile = join(options.consumer, "compile-minimal.mjs");
  await writeFile(
    compileFile,
    `import { readFile, writeFile } from "node:fs/promises";
import { compileSource } from "@typed-sql/compiler";
import { loadSchemaSnapshot } from "@typed-sql/schema";
import { postgres } from "@typed-sql/postgres";
const target = process.argv[2];
const source = 'import {sql} from "@typed-sql/postgres"; export const inline=sql\`SELECT id, name FROM users WHERE id = \${7}\`;';
const result=compileSource({source, schema:await loadSchemaSnapshot(target+"/schema.json"), dialect:postgres(), runtimeMetadata:true});
if(result.diagnostics.length) throw new Error(JSON.stringify(result.diagnostics));
await writeFile(target+"/inline.ts", result.transformedSource);`,
  );
  await execFile(process.execPath, [compileFile, project], { cwd: options.consumer, env: options.env });
  await writeFile(
    join(project, "run.ts"),
    `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import find from "./find.sql";
import { inline } from "./inline.ts";
import { createPostgresDatabase } from "@typed-sql/postgres/runtime";
const require=createRequire(import.meta.url);
assert.throws(()=>require.resolve("@typed-sql/core"), {code:"MODULE_NOT_FOUND"});
assert.throws(()=>require.resolve("@typed-sql/compiler"), {code:"MODULE_NOT_FOUND"});
const database=createPostgresDatabase({pool:{async query(){return {rows:[{id:7,name:"Ada"}]};}}});
assert.deepEqual(await database.all(find(7,"Ada")),[{id:7,name:"Ada"}]);
assert.deepEqual(await database.all(inline),[{id:7,name:"Ada"}]);
console.log("minimal-grammar-consumer-ok");`,
  );
  const run = await execFile(
    process.execPath,
    ["--import", "@typed-sql/ts-bridge/sql-register", join(project, "run.ts")],
    { cwd: project, env: options.env },
  );
  strict.match(run.stdout, /minimal-grammar-consumer-ok/u);
}
