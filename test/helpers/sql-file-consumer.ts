import { execFile as callback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { strict } from "poku";

const execFile = promisify(callback);

const sql = "SELECT id, name FROM users WHERE id = $1 AND name <> $2";

/** Shared fixture preparation; performs no compiler or runtime assertions. */
export async function prepareSqlFileConsumer(consumer: string): Promise<string> {
  const directory = join(consumer, "sql-file-consumer");
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(directory, "typed-sql.config.mjs"),
    `import { postgres } from "@typed-sql/postgres";
export default { dialect: postgres(), schema: { file: "schema.json" }, outDir: ".typed-sql" };`,
  );
  await writeFile(
    join(directory, "schema.json"),
    JSON.stringify({
      formatVersion: 1,
      dialect: "postgres",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { name: "id", databaseType: "integer", tsType: "number", nullable: false },
            name: { name: "name", databaseType: "text", tsType: "string", nullable: false },
          },
        },
      },
    }),
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2024",
        module: "NodeNext",
        types: [],
        skipLibCheck: true,
      },
      contentMappers: [{ package: "@typed-sql/ts-bridge", extensions: [".sql"] }],
      files: ["main.ts"],
    }),
  );
  await writeFile(join(directory, "find.sql"), sql);
  await writeFile(join(directory, "constant.sql"), "SELECT 1 AS value");
  await writeFile(
    join(directory, "main.ts"),
    `import find from "./find.sql";
import constant from "./constant.sql";
import type { QueryRow, QueryParameters } from "@typed-sql/core";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const query = find(7, "Ada");
const row: Equal<QueryRow<typeof query>, { id: number; name: string }> = true;
const parameters: Equal<QueryParameters<typeof query>, readonly [number, string]> = true;
// @ts-expect-error values follow the SQL placeholder order
find("wrong", 7);
// @ts-expect-error every placeholder needs a value
find(7);
const constantQuery = constant();
const empty: Equal<QueryParameters<typeof constantQuery>, readonly []> = true;
void [query, row, parameters, empty];`,
  );
  return directory;
}

/** Exercises the installed mapper manifest, beta compiler and Node runtime frontend. */
export async function assertSqlFileConsumer(options: {
  readonly consumer: string;
  readonly previewCli: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<void> {
  const directory = await prepareSqlFileConsumer(options.consumer);
  const check = () =>
    execFile(process.execPath, [options.previewCli, "-p", directory, "--runExternalCode", "--pretty", "false"], {
      cwd: directory,
      env: options.env,
    });
  await check();
  await strict.rejects(
    execFile(
      process.execPath,
      [
        options.previewCli,
        "-p",
        directory,
        "--runExternalCode",
        "--noEmit",
        "false",
        "--noEmitOnError",
        "--pretty",
        "false",
      ],
      { cwd: directory, env: options.env },
    ),
    (error: unknown) =>
      error instanceof Error && "stdout" in error && /requires noEmit: true/u.test(String(error.stdout)),
  );
  await strict.rejects(
    execFile(process.execPath, [options.previewCli, "-p", directory, "--pretty", "false"], {
      cwd: directory,
      env: options.env,
    }),
    (error: unknown) => error instanceof Error && "stdout" in error && /runExternalCode/u.test(String(error.stdout)),
  );
  await writeFile(
    join(directory, "run.ts"),
    `import assert from "node:assert/strict";
import find from "./find.sql";
import { createPostgresDatabase } from "@typed-sql/postgres/runtime";
const input: string = "Ada'; DROP TABLE users; --";
let seen;
const database = createPostgresDatabase({ pool: { async query(text, values) {
  seen = typeof text === "string" ? { text, values } : { text: text.text, values: text.values }; return { rows: [{ id: 7, name: "Ada" }], fields: [{ name: "id", dataTypeID: 23 }, { name: "name", dataTypeID: 25 }] };
} } });
assert.deepEqual(await database.all(find(7, input)), [{ id: 7, name: "Ada" }]);
assert.deepEqual(seen, { text: ${JSON.stringify(sql)}, values: [7, input] });
assert.throws(() => find(7), /expects 2/);
console.log("sql-file-consumer-ok");`,
  );
  const run = () =>
    execFile(process.execPath, ["--import", "@typed-sql/ts-bridge/sql-register", join(directory, "run.ts")], {
      cwd: directory,
      env: options.env,
    });
  const supportsRuntime = Number(process.versions.node.split(".")[0]) >= 24;
  if (supportsRuntime) strict.match((await run()).stdout, /sql-file-consumer-ok/u);
  else await strict.rejects(run(), /requires Node\.js 24 or newer/u);
  for (const invalid of [
    "SELECT '😀' AS emoji, definitely_missing FROM users",
    "SELECT '😀' AS emoji,\r\n  definitely_missing FROM users",
  ]) {
    await writeFile(join(directory, "find.sql"), invalid);
    const offset = invalid.indexOf("definitely_missing");
    const line = invalid.slice(0, offset).split("\n").length;
    const column = offset - invalid.lastIndexOf("\n", offset);
    await strict.rejects(check(), (error: unknown) => {
      if (!(error instanceof Error && "stdout" in error)) return false;
      strict.ok(
        String(error.stdout).includes(`find.sql(${line},${column}): error typed-sql101: TSQ101`),
        String(error.stdout),
      );
      return true;
    });
    if (supportsRuntime) await strict.rejects(run(), /TSQ101/u);
  }
  await writeFile(join(directory, "find.sql"), sql);
}
