import { execFile as callback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execFile = promisify(callback);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = resolve(workspace, "packages/cli/src/cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));

async function check(directory: string, file: string) {
  return execFile(
    process.execPath,
    [
      "--import",
      tsx,
      cli,
      "check",
      "--config",
      resolve(directory, "typed-sql.config.ts"),
      "--file",
      file,
      "--project",
      resolve(directory, "tsconfig.json"),
    ],
    { cwd: workspace },
  );
}

await describe("CLI check command boundaries", async () => {
  for (const grammar of ["postgres", "mysql"] as const) {
    await it(`${grammar}: reports SQL diagnostics at the original fragment location with a failing exit status`, async () => {
      const directory = resolve(workspace, "e2e", grammar);
      const temporary = await mkdtemp(resolve(directory, ".soundness-cli-"));
      try {
        const file = resolve(temporary, "query.ts");
        const source = [
          `import { sql } from "@typed-sql/${grammar}";`,
          "export const query = sql`SELECT users.id FROM users",
          "  ${sql.fragment`WHERE definitely_missing = ${1}`}",
          "`;",
        ].join("\n");
        await writeFile(file, source);
        const prefix = source.slice(0, source.indexOf("definitely_missing"));
        const line = prefix.split("\n").length;
        const column = prefix.length - prefix.lastIndexOf("\n");
        await strict.rejects(check(directory, file), (error: unknown) => {
          if (!(error instanceof Error && "code" in error && "stderr" in error && "stdout" in error)) return false;
          strict.strictEqual(error.code, 1);
          strict.strictEqual(error.stdout, "");
          strict.ok(String(error.stderr).startsWith(`${file}:${line}:${column} - error TSQ101:`), String(error.stderr));
          return true;
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  await it("accepts a valid query and an explicitly dynamic query without diagnostics", async () => {
    const directory = resolve(workspace, "e2e/postgres");
    const temporary = await mkdtemp(resolve(directory, ".soundness-cli-"));
    try {
      const file = resolve(temporary, "query.ts");
      await writeFile(
        file,
        [
          'import { sql } from "@typed-sql/postgres";',
          "export const query = sql`SELECT users.id FROM users WHERE users.id = ${1n}`;",
          'export const dynamic = sql.dynamic("SELECT anything");',
        ].join("\n"),
      );
      const result = await check(directory, file);
      strict.strictEqual(result.stdout, "");
      strict.strictEqual(result.stderr, "");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
