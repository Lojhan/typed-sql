import { execFile as callback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, skip, strict } from "poku";
import { buildQueryManifest, serializeQueryManifest } from "../../compiler/src/index.js";
import { postgres } from "../../postgres/src/index.js";
import { loadPgDriver } from "../../postgres/src/pg.js";
import { parseSchemaSnapshot } from "../../schema/src/index.js";

const targetUrl = process.env.TYPED_SQL_MIGRATION_TEST_URL,
  scratchUrl = process.env.TYPED_SQL_MIGRATION_SCRATCH_URL;
if (!targetUrl || !scratchUrl)
  skip("Set disposable migration target/scratch PostgreSQL URLs for the complete CLI flow.");
const execFile = promisify(callback),
  { Pool } = await loadPgDriver();
const target = new Pool({ connectionString: targetUrl }),
  scratch = new Pool({ connectionString: scratchUrl });
const schema = `cli_${randomUUID().replaceAll("-", "")}`,
  ledger = `ledger_${randomUUID().replaceAll("-", "")}`;
const root = await realpath(await mkdtemp(join(tmpdir(), "migration-cli-live-")));
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  tsx = fileURLToPath(import.meta.resolve("tsx"));
async function run(args: readonly string[]) {
  const result = await execFile(
    process.execPath,
    ["--import", tsx, join(workspace, "packages/cli/src/cli.ts"), "migrate", ...args, "--json"],
    { cwd: root },
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
try {
  await target.query(`create schema "${schema}"`);
  await scratch.query(`create schema "${schema}"`);
  const targetDatabase = (await target.query<{ name: string }>("select current_database() as name")).rows[0]!.name,
    scratchDatabase = (await scratch.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
  const grammar = pathToFileURL(join(workspace, "packages/postgres/dist/packages/postgres/src/index.js")).href,
    adapter = pathToFileURL(join(workspace, "packages/postgres/dist/packages/postgres/src/migrations.js")).href;
  await writeFile(
    join(root, "typed-sql.config.mjs"),
    `import { postgres } from ${JSON.stringify(grammar)};import { createPgMigrationTarget } from ${JSON.stringify(adapter)};\nconst make=(env,database,disposable=false)=>createPgMigrationTarget({connectionString:()=>process.env[env],expected:{database},classification:'test',disposable,namespaces:[${JSON.stringify(schema)}],historyNamespace:${JSON.stringify(ledger)}});\nexport default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',migrations:{directory:'migrations',replayTarget:'scratch',targets:{local:make('TYPED_SQL_MIGRATION_TEST_URL',${JSON.stringify(targetDatabase)}),scratch:make('TYPED_SQL_MIGRATION_SCRATCH_URL',${JSON.stringify(scratchDatabase)},true)}}};\n`,
  );
  await describe("live migration CLI vertical flow", async () => {
    await it("initializes, authors, plans, applies, reports additive drift and reverses using reviewed bundles", async () => {
      await run(["init", "--apply"]);
      const created = await run(["new", "accounts"]);
      const directory = String(created.file);
      const manifest = JSON.parse(await readFile(join(root, directory, "migration.json"), "utf8"));
      manifest.down = "down.sql";
      await writeFile(join(root, directory, "migration.json"), JSON.stringify(manifest));
      await writeFile(join(root, directory, "up.sql"), `create table "${schema}".accounts(id integer primary key)`);
      await writeFile(join(root, directory, "down.sql"), `drop table "${schema}".accounts`);
      const plan = await run(["plan", "--target", "local", "--out", ".typed-sql/migrations/up.json"]);
      strict.ok(plan.hash);
      const capture = await run([
        "verify",
        "--target",
        "scratch",
        "--before-through",
        "empty",
        "--capture-dir",
        ".typed-sql/capture",
      ]);
      strict.equal(capture.compatibility, "not-evaluated");
      const before = parseSchemaSnapshot(JSON.parse(await readFile(String(capture.beforeFile), "utf8"))),
        after = parseSchemaSnapshot(JSON.parse(await readFile(String(capture.afterFile), "utf8")));
      const queryManifest = (schema: typeof before, source: string) =>
        buildQueryManifest({
          rootDir: root,
          sources: [{ file: join(root, "query.ts"), source }],
          schema,
          dialect: postgres(),
          compilerVersion: "migration-cli-test",
        }).manifest;
      await writeFile(
        join(root, "before.queries.json"),
        serializeQueryManifest(
          queryManifest(
            before,
            'import { sql } from "@typed-sql/postgres"; export const query = sql`select 1 as value`;',
          ),
        ),
      );
      await writeFile(
        join(root, "after.queries.json"),
        serializeQueryManifest(
          queryManifest(
            after,
            `import { sql } from "@typed-sql/postgres"; export const query = sql\`select id from "${schema}".accounts\`;`,
          ),
        ),
      );
      const verified = await run([
        "verify",
        "--target",
        "scratch",
        "--before-through",
        "empty",
        "--before",
        ".typed-sql/capture/before.schema.json",
        "--after",
        ".typed-sql/capture/after.schema.json",
        "--before-manifest",
        "before.queries.json",
        "--after-manifest",
        "after.queries.json",
        "--fail-on",
        "none",
      ]);
      strict.equal(verified.kind, "typed-sql-migration-verification");
      strict.ok(verified.compatibility);
      const result = await run(["apply", "--target", "local", "--plan", ".typed-sql/migrations/up.json"]);
      strict.equal(result.state, "applied");
      strict.equal((await run(["status", "--target", "local"])).driftState, "current");
      await target.query(`alter table "${schema}".accounts add column manual_column integer`);
      try {
        await run(["plan", "--target", "local"]);
        strict.fail("manual drift accepted");
      } catch (error) {
        strict.equal(JSON.parse((error as { stdout: string }).stdout).code, "MIGRATION_DRIFT");
      }
      await target.query(`alter table "${schema}".accounts drop column manual_column`);
      await run([
        "plan",
        "--target",
        "local",
        "--direction",
        "down",
        "--to",
        "empty",
        "--out",
        ".typed-sql/migrations/down.json",
      ]);
      await run(["revert", "--target", "local", "--to", "empty", "--plan", ".typed-sql/migrations/down.json"]);
      strict.equal(
        (await target.query("select to_regclass($1) as relation", [`${schema}.accounts`])).rows[0]?.relation,
        null,
      );
    });
  });
} finally {
  await target.query(`drop schema if exists "${schema}" cascade`);
  await target.query(`drop schema if exists "${ledger}" cascade`);
  await scratch.query(`drop schema if exists "${schema}" cascade`);
  await scratch.query(`drop schema if exists "${ledger}" cascade`);
  await target.end();
  await scratch.end();
  await rm(root, { recursive: true, force: true });
}
