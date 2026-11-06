import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** One application process owns the actual native write lock for the complete offline check. */
export async function lockDatabase(project, environment) {
  const child = spawn(process.execPath, ["lock-holder.mjs"], {
    cwd: project,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const ended = new Promise((resolve) => child.once("close", resolve));
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected)
      child.send("close", (error) => {
        if (error) child.kill("SIGTERM");
      });
    else child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await ended;
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DuckDB lock holder timed out: ${output}`)), 15000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`DuckDB lock holder stopped (${code}): ${output}`));
      });
      child.once("message", (message) => {
        clearTimeout(timer);
        try {
          assert.equal(message.ready, true);
          assert.equal(message.engine, environment.TYPED_SQL_DUCKDB_EXPECTED_ENGINE);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function prepareProject(project, directory, schema) {
  await cp(join(directory, "project"), project, { recursive: true });
  if (schema) await writeFile(join(project, "schema.json"), schema);
}
export async function offlineCommands(fixture, project, environment) {
  const commands = [
    ["pnpm", ["exec", "typed-sql", "generate"]],
    ["pnpm", ["exec", "typed-sql-build", "types"]],
    ["pnpm", ["exec", "typed-sql-build", "types", "--check"]],
    ["pnpm", ["exec", "typed-sql", "check", "--project", "tsconfig.json", "--show-types"]],
    ["pnpm", ["exec", "tsc", "--noEmit"]],
    [process.execPath, ["build.mjs"]],
  ];
  let transcript = "";
  for (const [program, args] of commands) {
    const result = await fixture.command(project, program, args, { env: environment });
    transcript += `$ ${program} ${args.join(" ")}\n${result.output}\n`;
    await assert.rejects(access(join(project, "native-imports.log")), (error) => error.code === "ENOENT");
  }
  assert.match(await readFile(join(project, "find.d.sql.ts"), "utf8"), /"id": bigint/u);
  return transcript;
}
