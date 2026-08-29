import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const directory = process.cwd();
const sourceDirectory = join(directory, "src");
const cli = resolve(directory, "../../packages/cli/dist/packages/cli/src/cli.js");

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

function check(file) {
  return new Promise((resolveCheck, rejectCheck) => {
    process.stdout.write(`Checking ${relative(directory, file)}\n`);
    const child = spawn(
      process.execPath,
      [cli, "check", "--config", "typed-sql.config.ts", "--file", file, "--project", "tsconfig.json"],
      { cwd: directory, env: process.env, stdio: "inherit" },
    );
    child.once("error", rejectCheck);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCheck();
      else rejectCheck(new Error(`typed-sql check failed for ${relative(directory, file)} (${signal ?? code})`));
    });
  });
}

for (const file of (await sourceFiles(sourceDirectory)).sort()) await check(file);
