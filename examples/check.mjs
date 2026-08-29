import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const directory = process.cwd();
const cli = resolve(directory, "../../packages/cli/dist/packages/cli/src/cli.js");
const requested = process.argv.slice(2);
const targets =
  requested.length === 0
    ? [{ config: "typed-sql.config.ts", sourceDirectory: "src" }]
    : Array.from({ length: requested.length / 2 }, (_, index) => ({
        config: requested[index * 2],
        sourceDirectory: requested[index * 2 + 1],
      }));

if (
  requested.length % 2 !== 0 ||
  targets.some((target) => target.config === undefined || target.sourceDirectory === undefined)
) {
  throw new TypeError("usage: node examples/check.mjs [config source-directory]...");
}

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? sourceFiles(child) : entry.name.endsWith(".ts") ? [child] : [];
    }),
  );
  return files.flat();
}

function check(config, file) {
  return new Promise((resolveCheck, rejectCheck) => {
    process.stdout.write(`Checking ${relative(directory, file)}\n`);
    const child = spawn(
      process.execPath,
      [cli, "check", "--config", config, "--file", file, "--project", "tsconfig.json"],
      { cwd: directory, env: process.env, stdio: "inherit" },
    );
    child.once("error", rejectCheck);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCheck();
      else rejectCheck(new Error(`typed-sql check failed for ${relative(directory, file)} (${signal ?? code})`));
    });
  });
}

for (const target of targets) {
  for (const file of (await sourceFiles(resolve(directory, target.sourceDirectory))).sort()) {
    await check(target.config, file);
  }
}
