import { execFile as callback } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execFile = promisify(callback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(workspace, "packages/cli/src/cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
async function run(root: string, args: readonly string[]) {
  return execFile(process.execPath, ["--import", tsx, cli, "migrate", ...args], { cwd: root });
}
await describe("migration CLI authoring", async () => {
  await it("provides config-free help and rejects unsupported flags before config evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-cli-"));
    try {
      const help = await run(root, ["--help"]);
      strict.match(help.stdout, /reconcile plan\|apply/);
      try {
        await run(root, ["plan", "--apply", "--json"]);
        strict.fail("invalid option accepted");
      } catch (error) {
        strict.equal((error as { code: number }).code, 2);
        strict.equal(JSON.parse((error as { stdout: string }).stdout).code, "MIGRATION_USAGE");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await it("previews initialization, authors SQL and selected-grammar TS offline, and reports missing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-cli with spaces-"));
    try {
      const postgres = pathToFileURL(join(workspace, "packages/postgres/dist/packages/postgres/src/analysis.js")).href;
      await writeFile(
        join(root, "typed-sql.config.mjs"),
        `import { postgres } from ${JSON.stringify(postgres)};\nexport default {dialect:postgres(),schema:{file:'schema.json'},outDir:'generated',migrations:{directory:'migrations',targets:{}}};\n`,
      );
      const preview = JSON.parse((await run(root, ["init", "--json"])).stdout);
      strict.equal(preview.state, "preview");
      await strict.rejects(access(join(root, "migrations")));
      await run(root, ["init", "--apply", "--json"]);
      await run(root, ["init", "--apply", "--json"]);
      const sql = JSON.parse((await run(root, ["new", "initial-schema", "--json"])).stdout);
      strict.equal(sql.verification, "offline-unverified");
      strict.ok((await readFile(join(root, sql.file, "migration.json"), "utf8")).includes('"formatVersion": 1'));
      const ts = JSON.parse((await run(root, ["new", "second-change", "--format", "ts", "--json"])).stdout);
      strict.match(await readFile(join(root, ts.file), "utf8"), /from "@typed-sql\/postgres"/);
      try {
        await run(root, ["apply", "--target", "missing", "--json"]);
        strict.fail("missing target accepted");
      } catch (error) {
        strict.equal(JSON.parse((error as { stdout: string }).stdout).code, "MIGRATION_TARGET");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
