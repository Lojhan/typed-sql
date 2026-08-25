import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execFile = promisify(execFileCallback);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(packageDirectory, "src", "cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const version = (JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
  readonly version: string;
}).version;

async function execute(args: readonly string[], cwd: string) {
  return execFile(process.execPath, ["--import", tsx, cli, ...args], { cwd });
}

await describe("typed-sql CLI discovery-free commands", async () => {
  await it("shows help without requiring a project config", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      for (const args of [[], ["--help"], ["-h"], ["generate", "--help"]]) {
        const result = await execute(args, temporary);
        strict.match(result.stdout, new RegExp(`typed-sql ${version}`, "u"));
        strict.match(result.stdout, /Usage:\n  typed-sql <command> \[options\]/u);
        strict.match(result.stdout, /check[\s\S]*generate[\s\S]*drift/u);
        strict.strictEqual(result.stderr, "");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("shows the installed package version without requiring a project config", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      for (const flag of ["--version", "-v"]) {
        const result = await execute([flag], temporary);
        strict.strictEqual(result.stdout, `${version}\n`);
        strict.strictEqual(result.stderr, "");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("rejects unknown commands before config discovery", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "typed-sql-cli-"));
    try {
      await strict.rejects(
        execute(["unknown"], temporary),
        (error: unknown) => {
          if (!(error instanceof Error && "stderr" in error)) return false;
          strict.match(String(error.stderr), /Unknown command unknown/u);
          strict.ok(!String(error.stderr).includes("typed-sql.config.ts"));
          return true;
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
