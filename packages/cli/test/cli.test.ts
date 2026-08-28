import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, strict } from "poku";

const execFile = promisify(execFileCallback);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(packageDirectory, "../..");
const cli = join(packageDirectory, "src", "cli.ts");
const tsx = fileURLToPath(import.meta.resolve("tsx"));
const version = (
  JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
    readonly version: string;
  }
).version;

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
        strict.match(result.stdout, /Usage:\n {2}typed-sql <command> \[options\]/u);
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
      await strict.rejects(execute(["unknown"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "stderr" in error)) return false;
        strict.match(String(error.stderr), /Unknown command unknown/u);
        strict.ok(!String(error.stderr).includes("typed-sql.config.ts"));
        return true;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

await describe("typed-sql manifest command", async () => {
  await it("writes deterministic project manifests and reuses unchanged analysis", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-manifest-"));
    try {
      await mkdir(join(temporary, "src"));
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres, typePolicy } from "@typed-sql/postgres";',
          "export default defineConfig({",
          "  dialect: postgres(),",
          '  schema: { file: "schema.json" },',
          '  outDir: "generated",',
          '  projects: ["tsconfig.json"],',
          '  manifest: { outFile: ".typed-sql/queries.json" },',
          "  typePolicy,",
          "});",
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({
          formatVersion: 1,
          dialect: "postgres",
          tables: {
            users: {
              name: "users",
              columns: {
                id: { name: "id", databaseType: "bigint", tsType: "bigint", nullable: false },
              },
            },
          },
        })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({
          extends: "../tsconfig.base.json",
          compilerOptions: { composite: false },
          include: ["src/**/*.ts"],
        })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT users.id FROM users`;\n',
      );

      const first = await execute(["manifest"], temporary);
      strict.match(first.stdout, /Generated 1 queries \(0 unresolved, 0 files reused\)/u);
      const outFile = join(temporary, ".typed-sql", "queries.json");
      const initial = await readFile(outFile, "utf8");
      const second = await execute(["manifest"], temporary);
      strict.match(second.stdout, /Generated 1 queries \(0 unresolved, 1 files reused\)/u);
      strict.strictEqual(await readFile(outFile, "utf8"), initial);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  await it("writes unresolved entries with exit code 2, distinct from build failures", async () => {
    const temporary = await mkdtemp(join(workspace, ".typed-sql-cli-manifest-"));
    try {
      await mkdir(join(temporary, "src"));
      await writeFile(
        join(temporary, "typed-sql.config.ts"),
        [
          'import { defineConfig } from "@typed-sql/core";',
          'import { postgres } from "@typed-sql/postgres";',
          'export default defineConfig({ dialect: postgres(), schema: { file: "schema.json" }, outDir: "generated", projects: ["tsconfig.json"] });',
        ].join("\n"),
      );
      await writeFile(
        join(temporary, "schema.json"),
        `${JSON.stringify({ formatVersion: 1, dialect: "postgres", tables: {} })}\n`,
      );
      await writeFile(
        join(temporary, "tsconfig.json"),
        `${JSON.stringify({ extends: "../tsconfig.base.json", include: ["src/**/*.ts"] })}\n`,
      );
      await writeFile(
        join(temporary, "src", "query.ts"),
        'import { sql } from "@typed-sql/postgres"; export const query = sql`SELECT missing FROM absent`;\n',
      );
      await strict.rejects(execute(["manifest"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "code" in error && "stdout" in error)) return false;
        strict.strictEqual(error.code, 2);
        strict.match(String(error.stdout), /1 unresolved/u);
        return true;
      });
      const manifest = JSON.parse(await readFile(join(temporary, ".typed-sql", "queries.json"), "utf8")) as {
        readonly queries: readonly { readonly status: string }[];
      };
      strict.strictEqual(manifest.queries[0]?.status, "unresolved");
      await strict.rejects(execute(["manifest", "--project", "missing.json"], temporary), (error: unknown) => {
        if (!(error instanceof Error && "code" in error)) return false;
        strict.strictEqual(error.code, 1);
        return true;
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
