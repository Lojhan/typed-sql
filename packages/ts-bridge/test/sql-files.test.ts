import { execFile as callback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict, waitForExpectedResult } from "poku";
import { assertSqlFileConsumer, prepareSqlFileConsumer } from "../../../test/helpers/sql-file-consumer.js";
import { typescriptPreviewCliPath } from "../src/native-lsp.js";
import { analyzeSqlFile, loadSqlFileProject } from "../src/sql-file.js";

const execFile = promisify(callback);

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(workspace, ".sql-files-"));
  try {
    const scope = join(directory, "node_modules/@typed-sql");
    await mkdir(scope, { recursive: true });
    for (const name of ["core", "config", "compiler", "schema", "postgres", "mysql", "sqlite", "ts-bridge"]) {
      await symlink(
        join(workspace, "packages", name),
        join(scope, name),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await describe("official SQL content mapper", async () => {
  await it("loads the actual CommonJS pg driver after the SQL preload or rejects unsupported Node patches", async () => {
    await fixture(async (consumer) => {
      const directory = await prepareSqlFileConsumer(consumer);
      const run = () =>
        execFile(
          process.execPath,
          [
            "--import",
            "@typed-sql/ts-bridge/sql-register",
            "--input-type=module",
            "-e",
            "const { default: pg } = await import('pg'); console.log(typeof pg.Pool, typeof pg.Client);",
          ],
          { cwd: directory, env: process.env },
        );
      const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
      const supported =
        major > 25 || (major === 25 && minor >= 1) || (major === 24 && (minor > 11 || (minor === 11 && patch >= 1)));
      if (supported) strict.match((await run()).stdout, /function function/u);
      else await strict.rejects(run(), /requires Node\.js 24\.11\.1 or newer/u);
    });
  });

  await it("checks fresh imports with real beta tsc and executes the same branded queries through Node", async () => {
    await fixture(async (consumer) =>
      assertSqlFileConsumer({ consumer, previewCli: typescriptPreviewCliPath(), env: process.env }),
    );
  });

  await it("fails closed for ambiguous parameter cardinality and preserves original UTF-16 diagnostic offsets", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "typed-sql.config.mjs"),
        `import { postgres } from '@typed-sql/postgres'; export default {dialect:postgres(),schema:{file:'schema.json'},outDir:'.typed-sql'};`,
      );
      await writeFile(join(directory, "schema.json"), JSON.stringify({ dialect: "postgres", tables: {} }));
      const project = await loadSqlFileProject(directory);
      for (const text of ["SELECT $1 AS a, $1 AS b", "SELECT $2 AS a", "SELECT $2 AS a, $1 AS b"]) {
        const result = analyzeSqlFile(text, project);
        strict.ok(result.diagnostics.some((item) => item.code === 901));
        strict.match(result.text, /query: never/u);
        strict.match(result.runtime, /throw new SyntaxError/u);
      }
      const parameterSource = "SELECT $1 AS value";
      const placeholder = parameterSource.indexOf("$1");
      for (const occurrences of [
        [],
        [{ index: 1, range: { start: -1, end: 2, line: 1, column: 1 } }],
        [{ index: 1, range: { start: placeholder, end: parameterSource.length + 1, line: 1, column: 1 } }],
        [{ index: 1, range: { start: placeholder, end: placeholder, line: 1, column: 1 } }],
        [
          { index: 1, range: { start: placeholder, end: placeholder + 2, line: 1, column: placeholder + 1 } },
          { index: 2, range: { start: placeholder, end: placeholder + 2, line: 1, column: placeholder + 1 } },
        ],
      ]) {
        const broken = {
          ...project,
          loaded: {
            ...project.loaded,
            config: {
              ...project.loaded.config,
              dialect: { ...project.loaded.config.dialect, parameterOccurrences: () => occurrences },
            },
          },
        };
        const result = analyzeSqlFile(parameterSource, broken);
        strict.ok(result.diagnostics.some((item) => item.code === 901));
        strict.match(result.text, /query: never/u);
        strict.match(result.runtime, /throw new SyntaxError/u);
      }
      const source = "SELECT '😀' AS emoji,\n  missing FROM nowhere";
      const result = analyzeSqlFile(source, project);
      strict.ok(
        result.diagnostics.some((item) => source.slice(item.start, item.start + item.length).includes("nowhere")),
      );
    });
  });

  await it("refreshes schema and imported config dependencies in the official compiler watch process", async () => {
    await fixture(async (consumer) => {
      const directory = await prepareSqlFileConsumer(consumer);
      const schemaFile = join(directory, "schema.json");
      const schema = JSON.parse(await readFile(schemaFile, "utf8"));
      await writeFile(
        join(directory, "policy.mjs"),
        'import { typePolicy } from "@typed-sql/postgres"; export const policy = { ...typePolicy, bigint: "bigint" };',
      );
      await writeFile(
        join(directory, "typed-sql.config.mjs"),
        `import { postgres } from '@typed-sql/postgres'; import {policy} from './policy.mjs'; export default {dialect:postgres({typePolicy:policy}),schema:{file:'schema.json'},outDir:'.typed-sql'};`,
      );
      await writeFile(join(directory, "find.sql"), "SELECT id, name FROM users WHERE id = $1 AND name <> $2");
      await writeFile(join(directory, "main.ts"), "import find from './find.sql'; find(7, 'Ada');");
      // Use the exact binary selected by the installed official CLI wrapper. Older
      // supported Node releases use execFileSync rather than execve in that wrapper,
      // which prevents terminating the watch child through the wrapper process.
      const { default: getExePath } = await import(
        pathToFileURL(resolve(dirname(typescriptPreviewCliPath()), "../lib/getExePath.js")).href
      );
      const child = spawn(
        getExePath(),
        ["-p", directory, "--runExternalCode", "--watch", "--preserveWatchOutput", "--pretty", "false"],
        { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += String(data);
      });
      child.stderr.on("data", (data) => {
        output += String(data);
      });
      const waitFor = async (pattern: RegExp) =>
        waitForExpectedResult(() => pattern.test(output), true, { timeout: 20_000, interval: 50 });
      try {
        await waitFor(/Found 0 errors/u);
        output = "";
        delete schema.tables.users.columns.name;
        await writeFile(schemaFile, JSON.stringify(schema));
        await waitFor(/TSQ101/u);
        output = "";
        schema.tables.users.columns.name = { name: "name", databaseType: "text", tsType: "string", nullable: false };
        schema.tables.users.columns.id.databaseType = "bigint";
        schema.tables.users.columns.id.tsType = "bigint";
        await writeFile(schemaFile, JSON.stringify(schema));
        await waitFor(/not assignable to parameter of type 'bigint'/u);
        output = "";
        await writeFile(
          join(directory, "policy.mjs"),
          'import { typePolicy } from "@typed-sql/postgres"; export const policy = { ...typePolicy, bigint: "number" };',
        );
        await waitFor(/Found 0 errors/u);
      } finally {
        await new Promise<void>((resolveClose, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Compiler watch process did not close"));
          }, 5_000);
          child.once("close", () => {
            clearTimeout(timeout);
            resolveClose();
          });
          child.kill();
        });
      }
    });
  });
});
