import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumer } from "../build/src/consumer.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(directory, "../../artifacts/sqlserver");
const offlineCommands = [
  ["pnpm", ["exec", "typed-sql", "generate"]],
  ["pnpm", ["exec", "typed-sql-build", "types"]],
  ["pnpm", ["exec", "typed-sql-build", "types", "--check"]],
  ["pnpm", ["exec", "typed-sql", "check", "--project", "tsconfig.json", "--show-types"]],
  ["pnpm", ["exec", "tsc", "--noEmit"]],
  [process.execPath, ["build.mjs"]],
];
async function prepare(project) {
  await cp(join(directory, "project"), project, { recursive: true });
  await cp(resolve(directory, "../../examples/sqlserver/schema/001-schema.sql"), join(project, "schema.sql"));
}
export async function replayOffline(fixture, project, environment) {
  let transcript = "";
  for (const [program, args] of offlineCommands) {
    const result = await fixture.command(project, program, args, { env: environment });
    transcript += `$ ${program} ${args.join(" ")}\n${result.output}\n`;
    // Neither SDK import nor pool acquisition is legitimate in these offline commands.
    await assert.rejects(access(join(project, "native-imports.log")), (error) => error.code === "ENOENT");
  }
  assert.match(await readFile(join(project, "find.d.sql.ts"), "utf8"), /"id": bigint/u);
  const source = join(project, "inline.ts");
  const valid = await readFile(source, "utf8");
  try {
    // Replay the tutorial's error boundary, then restore the valid application.
    await writeFile(
      source,
      `${valid}\nconst wrongId = "1";\nexport const wrongAccount = sql\`SELECT id FROM dbo.users WHERE id = \${wrongId}\`;\n`,
    );
    const rejected = await fixture.command(
      project,
      "pnpm",
      ["exec", "typed-sql", "check", "--project", "tsconfig.json"],
      { env: environment, allowFailure: true },
    );
    assert.notEqual(rejected.code, 0, "String interpolation must fail the bigint predicate contract");
    assert.match(rejected.output, /TS2345/u);
    assert.match(rejected.output, /bigint/u);
    transcript += `$ typed-sql check (deliberate tutorial mismatch)\n${rejected.output}\n`;
    await assert.rejects(access(join(project, "native-imports.log")), (error) => error.code === "ENOENT");
  } finally {
    await writeFile(source, valid);
  }
  return transcript;
}
/** Full first-use replay imports every product API from independently installed tarballs. */
export async function firstUse(fixture) {
  const project = join(fixture.directory, "first-use");
  const database = `typed_sql_first_use_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const environment = { TYPED_SQL_FIRST_USE_DATABASE: database };
  const prefix = `first-use-${process.env.TYPED_SQL_SQLSERVER_MAJOR}`;
  const password = process.env.TYPED_SQL_SQLSERVER_PASSWORD;
  const redact = (value) => (password ? String(value).replaceAll(password, "[redacted]") : String(value));
  const save = (name, text) => writeFile(join(artifacts, `${prefix}-${name}.log`), redact(text));
  await mkdir(artifacts, { recursive: true });
  await prepare(project);
  let cleanupFailure;
  try {
    const setup = await fixture.command(project, process.execPath, ["setup.mjs", "create"], { env: environment });
    await save("setup", setup.output);
    const generated = await fixture.command(
      project,
      "pnpm",
      ["exec", "typed-sql", "generate", "--config", "online.config.mjs"],
      { env: environment },
    );
    await save("online-generate", generated.output);
    assert.equal(await readFile(join(project, "native-imports.log"), "utf8"), "SDK initialized\n");
    const schema = await readFile(join(project, "generated/db/schema.json"), "utf8");
    const snapshot = JSON.parse(schema);
    assert.equal(snapshot.formatVersion, 2);
    assert.equal(snapshot.server.settings.arithAbort, true);
    assert.equal(snapshot.server.version, process.env.TYPED_SQL_SQLSERVER_BUILD);
    for (const name of ["users", "teams", "memberships", "products", "orders", "order_items", "audit_events"])
      assert.equal(snapshot.relations[`dbo.${name}`].kind, "table");
    await rm(join(project, "native-imports.log"));
    await save("offline", await replayOffline(fixture, project, environment));
    // The independent installation has no application-owned SDK at all. It receives
    // only the native-generated snapshot, never a live database dependency.
    const noDriver = await consumer(
      ["typescript", "@types/node", "esbuild"],
      ["@typed-sql/sqlserver", "@typed-sql/cli"],
    );
    try {
      await assert.rejects(stat(join(noDriver.directory, "node_modules/koffi")), (error) => error.code === "ENOENT");
      const offline = join(noDriver.directory, "first-use");
      await prepare(offline);
      await mkdir(join(offline, "generated/db"), { recursive: true });
      await writeFile(join(offline, "generated/db/schema.json"), schema);
      await save("offline-no-sdk", await replayOffline(noDriver, offline, environment));
    } finally {
      await noDriver.close();
    }
    const executed = await fixture.command(project, process.execPath, ["execute.mjs"], { env: environment });
    await save("execute", executed.output);
    assert.equal(await readFile(join(project, "native-imports.log"), "utf8"), "SDK initialized\nSDK initialized\n");
    await rm(join(artifacts, `${prefix}-failure.log`), { force: true });
    console.log(
      "SQL Server packed first-use online/offline generation, checks, SQL declarations, esbuild and native execution passed",
    );
  } catch (error) {
    await save("failure", error);
    throw error;
  } finally {
    // Even a failed setup or replay can only drop the generated disposable name.
    try {
      const cleanup = await fixture.command(project, process.execPath, ["setup.mjs", "drop"], { env: environment });
      await save("cleanup", cleanup.output);
    } catch (error) {
      await save("cleanup-failure", error);
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}
