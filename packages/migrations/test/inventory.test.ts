import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { ensureDirectory, loadInventory, MigrationError, safePath, verifyCapturedFiles } from "../src/index.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const renderer = {
  placeholder: (index: number) => `$${index}`,
  quoteIdentifier: (value: string) => `"${value.replaceAll('"', '""')}"`,
};
await describe("migration inventory and trusted TS capture", async () => {
  await it("captures SQL-in-TS without an after-schema and detects imported helper changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-ts with spaces-"));
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await mkdir(join(root, "node_modules", "@typed-sql"), { recursive: true });
      await symlink(
        join(project, "packages", "migrations"),
        join(root, "node_modules", "@typed-sql", "migrations"),
        "dir",
      );
      await symlink(join(project, "packages", "postgres"), join(root, "node_modules", "@typed-sql", "postgres"), "dir");
      await mkdir(join(root, "migrations"));
      await writeFile(join(root, "migrations", "helper.ts"), "export const tableName = 'accounts';\n");
      await writeFile(
        join(root, "migrations", "001.migration.ts"),
        "import { sql } from '@typed-sql/postgres';\nimport { defineMigration } from '@typed-sql/migrations';\nimport { tableName } from './helper.js';\nexport default defineMigration({ id:'001', up:[sql`create table ${sql.ident(tableName)} (id integer)`], down:[sql`drop table ${sql.ident(tableName)}`] });\n",
      );
      const result = await loadInventory(root, "migrations", renderer);
      strict.equal(result.migrations[0]?.up[0]?.text, 'create table "accounts" (id integer)');
      strict.ok(Object.keys(result.migrations[0]!.files).some((path) => path.endsWith("helper.ts")));
      await writeFile(join(root, "migrations", "helper.ts"), "export const tableName = 'changed';\n");
      await strict.rejects(verifyCapturedFiles(root, result.migrations), /changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await it("accepts OS ancestor aliases but rejects nested symlink escapes before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "migration-path-"));
    const outside = await mkdtemp(join(tmpdir(), "migration-outside-"));
    try {
      await ensureDirectory(root, "migrations/nested");
      strict.equal(
        await realpath(await safePath(root, "migrations/nested")),
        await realpath(join(root, "migrations/nested")),
      );
      await symlink(outside, join(root, "escape"), "dir");
      await strict.rejects(
        ensureDirectory(root, "escape/created"),
        (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_PATH",
      );
      await strict.rejects(ensureDirectory(root, "../outside"), /inside the project/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
