import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";
import { assertSqlFileConsumer, prepareSqlFileConsumer } from "../../../test/helpers/sql-file-consumer.js";
import { typescriptPreviewCliPath } from "../src/native-lsp.js";
import { compilerWatch } from "./helpers/compiler-watch.js";

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

  await it("refreshes schema and imported config dependencies in the official compiler watch process", async () => {
    await fixture(async (consumer) => {
      const directory = await prepareSqlFileConsumer(consumer);
      const schemaFile = join(directory, "schema.json");
      const schema = JSON.parse(await readFile(schemaFile, "utf8"));
      const tsconfigFile = join(directory, "tsconfig.json");
      const tsconfig = JSON.parse(await readFile(tsconfigFile, "utf8"));
      tsconfig.compilerOptions.noUnusedLocals = true;
      await writeFile(tsconfigFile, JSON.stringify(tsconfig));
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
      const watch = await compilerWatch(directory, true);
      try {
        await watch.ready();
        for (let round = 0; round < 3; round++) {
          await watch.change(
            `remove schema column (${round})`,
            async () => {
              delete schema.tables.users.columns.name;
              await writeFile(schemaFile, JSON.stringify(schema));
            },
            2,
            /TSQ101/u,
          );
          await watch.change(
            `restore column and change native type (${round})`,
            async () => {
              schema.tables.users.columns.name = {
                name: "name",
                databaseType: "text",
                tsType: "string",
                nullable: false,
              };
              schema.tables.users.columns.id.databaseType = "bigint";
              schema.tables.users.columns.id.tsType = "bigint";
              await writeFile(schemaFile, JSON.stringify(schema));
            },
            1,
            /not assignable to parameter of type 'bigint'/u,
          );
          await watch.change(
            `change imported type policy (${round})`,
            () =>
              writeFile(
                join(directory, "policy.mjs"),
                'import { typePolicy } from "@typed-sql/postgres"; export const policy = { ...typePolicy, bigint: "number" };',
              ),
            0,
          );
          await watch.change(
            `restore imported type policy (${round})`,
            () =>
              writeFile(
                join(directory, "policy.mjs"),
                'import { typePolicy } from "@typed-sql/postgres"; export const policy = { ...typePolicy, bigint: "bigint" };',
              ),
            1,
            /not assignable to parameter of type 'bigint'/u,
          );
          await watch.change(
            `restore integer schema (${round})`,
            async () => {
              schema.tables.users.columns.id.databaseType = "integer";
              schema.tables.users.columns.id.tsType = "number";
              await writeFile(schemaFile, JSON.stringify(schema));
            },
            0,
          );
        }
      } finally {
        await watch.close();
      }
    });
  });
});
