import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SqlRenderer } from "@typed-sql/core";
import { tsImport } from "tsx/esm/api";
import { digest, hashBytes, MigrationError, object } from "./codec.js";
import { captureMigration } from "./definition.js";
import type { CapturedMigration, MigrationDefinition } from "./types.js";

const limit = 2 * 1024 * 1024;
async function readBounded(file: string): Promise<string> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > limit)
    throw new MigrationError("MIGRATION_FILE", "Migration inputs must be regular files no larger than 2 MiB.");
  return readFile(file, "utf8");
}
export async function safePath(root: string, path: string): Promise<string> {
  const resolved = resolve(root, path);
  const actual = await realpath(resolved);
  const prefix = await realpath(root);
  const inside = relative(resolve(root), resolved);
  if (
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside) ||
    actual !== resolve(prefix, inside) ||
    (actual !== prefix && !actual.startsWith(prefix + sep))
  )
    throw new MigrationError(
      "MIGRATION_PATH",
      "Migration paths must remain inside their configured root without symlinks.",
    );
  return resolved;
}
/** Creates only descendants, inspecting each existing component before any write. */
export async function ensureDirectory(root: string, path: string): Promise<string> {
  const selected = resolve(root, path),
    inside = relative(resolve(root), selected);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new MigrationError("MIGRATION_PATH", "Output directory must remain inside the project.");
  let current = resolve(root);
  await safePath(root, current);
  for (const part of inside.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new MigrationError("MIGRATION_PATH", "Output directory contains a symlink or non-directory.");
      await safePath(root, current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") await mkdir(current, { mode: 0o700 });
      else throw error;
    }
  }
  return selected;
}
export async function inventoryFiles(root: string, directory: string): Promise<Readonly<Record<string, string>>> {
  const dir = resolve(root, directory);
  if (!dir.startsWith(resolve(root) + sep))
    throw new MigrationError("MIGRATION_PATH", "Migration directory must be inside the configuration directory.");
  const output: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = await safePath(root, join(path, entry.name));
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:json|sql|[cm]?ts)$/u.test(entry.name)) {
        if (Object.keys(output).length >= 10000)
          throw new MigrationError("MIGRATION_LIMIT", "Migration inventory exceeds 10,000 files.");
        output[relative(root, file)] = hashBytes(await readBounded(file));
      }
    }
  }
  try {
    await visit(await safePath(root, dir));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new MigrationError(
        "MIGRATION_DIRECTORY",
        "Migration directory is missing. Run typed-sql migrate init --apply.",
      );
    throw error;
  }
  return output;
}
export async function loadInventory(
  root: string,
  directory: string,
  renderer: SqlRenderer,
): Promise<{
  migrations: readonly CapturedMigration[];
  files: Readonly<Record<string, string>>;
  inputs: Readonly<Record<string, string>>;
}> {
  const all = await inventoryFiles(root, directory);
  const graphInputs: Record<string, string> = { ...all };
  const migrations: CapturedMigration[] = [];
  for (const entry of Object.keys(all).sort()) {
    if (entry.endsWith("/migration.json")) {
      const manifest = object(JSON.parse(await readBounded(resolve(root, entry))), "migration.json");
      const allowed = [
        "formatVersion",
        "id",
        "description",
        "transaction",
        "up",
        "down",
        "irreversibleReason",
        "checks",
        "reconciliation",
      ];
      if (
        manifest.formatVersion !== 1 ||
        Object.keys(manifest).some((key) => !allowed.includes(key)) ||
        typeof manifest.id !== "string" ||
        typeof manifest.up !== "string"
      )
        throw new MigrationError(
          "MIGRATION_MANIFEST",
          "Invalid migration.json; expected formatVersion: 1, id and up SQL path.",
        );
      const files: Record<string, string> = { [entry]: all[entry]! };
      const readSql = async (path: unknown): Promise<string> => {
        if (typeof path !== "string" || isAbsolute(path))
          throw new MigrationError("MIGRATION_PATH", "SQL asset path must be relative.");
        const file = await safePath(dirname(resolve(root, entry)), path);
        const source = await readBounded(file);
        files[relative(root, file)] = hashBytes(source);
        return source;
      };
      const up = await readSql(manifest.up);
      const down = manifest.down === undefined ? undefined : await readSql(manifest.down);
      migrations.push(
        captureMigration(
          { ...manifest, up: [up], ...(down === undefined ? {} : { down: [down] }) } as unknown as MigrationDefinition,
          files,
          renderer,
        ),
      );
    } else if (/(?:^|\/)[^/]+\.migration\.[cm]?ts$/u.test(entry)) {
      const dependencies = new Set<string>([resolve(root, entry)]);
      const evaluate = async () => {
        const module = await tsImport(pathToFileURL(resolve(root, entry)).href, {
          parentURL: import.meta.url,
          onImport: (url: string) => {
            if (url.startsWith("file:")) dependencies.add(fileURLToPath(url));
          },
        });
        const files: Record<string, string> = {};
        for (const dependency of [...dependencies].sort()) {
          const source = await readBounded(dependency);
          const key = relative(root, dependency);
          if (
            !key.split(sep).includes("node_modules") &&
            /\.[cm]?ts$/u.test(dependency) &&
            (/\bimport\s*\(/u.test(source) || /\brequire\s*\(/u.test(source) || /\bprocess\.env\b/u.test(source))
          )
            throw new MigrationError(
              "MIGRATION_TS_DYNAMIC",
              "Migration modules must use static imports and cannot read process.env. Capture stable SQL and keep connection configuration outside migration source.",
            );
          files[key] = hashBytes(source);
        }
        Object.assign(graphInputs, files);
        // Tool/runtime dependencies bind the reviewed plan, not historical migration identity.
        // User source/helper bytes and rendered operations remain immutable across reversals.
        const sourceFiles = Object.fromEntries(
          Object.entries(files).filter(
            ([path]) =>
              !path.split(sep).includes("node_modules") && (!path.startsWith(`..${sep}`) || /\.[cm]?ts$/u.test(path)),
          ),
        );
        return captureMigration(module.default as MigrationDefinition, sourceFiles, renderer);
      };
      const captured = await evaluate();
      if (digest(await evaluate()) !== digest(captured))
        throw new MigrationError(
          "MIGRATION_NONDETERMINISTIC",
          "Migration module produced different operations across evaluations; remove clock, random or external inputs.",
        );
      migrations.push(captured);
    }
  }
  migrations.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(migrations.map((m) => m.id)).size !== migrations.length)
    throw new MigrationError("MIGRATION_DUPLICATE", "Duplicate migration ID in inventory.", 3);
  if (digest(await inventoryFiles(root, directory)) !== digest(all))
    throw new MigrationError(
      "MIGRATION_SOURCE_CHANGED",
      "Migration source changed during module capture; retry with stable files.",
      3,
    );
  return { migrations, files: all, inputs: graphInputs };
}
export async function verifyCapturedFiles(root: string, migrations: readonly CapturedMigration[]): Promise<void> {
  for (const migration of migrations)
    for (const [path, hash] of Object.entries(migration.files)) {
      let current: string;
      try {
        current = hashBytes(await readBounded(resolve(root, path)));
      } catch {
        throw new MigrationError(
          "MIGRATION_SOURCE_CHANGED",
          `Captured input is missing or unreadable for migration ${migration.id}.`,
          3,
        );
      }
      if (current !== hash)
        throw new MigrationError(
          "MIGRATION_SOURCE_CHANGED",
          `Captured input changed for migration ${migration.id}. Create and review a new plan.`,
          3,
        );
    }
}
export async function verifyInputFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, hash] of Object.entries(files)) {
    let current: string;
    try {
      current = hashBytes(await readBounded(resolve(root, path)));
    } catch {
      throw new MigrationError("MIGRATION_SOURCE_CHANGED", "A captured migration input is missing or unreadable.", 3);
    }
    if (current !== hash)
      throw new MigrationError("MIGRATION_SOURCE_CHANGED", "A captured migration input changed after review.", 3);
  }
}
export async function createMigration(
  root: string,
  directory: string,
  name: string,
  format: "sql" | "ts" = "sql",
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,79}$/u.test(name))
    throw new MigrationError("MIGRATION_NAME", "Use a lowercase migration name with letters, numbers and hyphens.");
  const id = `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}_${randomBytes(3).toString("hex")}_${name}`;
  const base = resolve(root, directory);
  await safePath(root, base);
  if (format === "ts") {
    const file = join(base, `${id}.migration.ts`);
    await writeFile(
      file,
      `import { sql } from '@typed-sql/postgres';\nimport { defineMigration } from '@typed-sql/migrations';\n\nexport default defineMigration({\n  id: '${id}',\n  transaction: 'required',\n  up: [sql\`-- Write reviewed SQL here\`],\n  irreversibleReason: 'Declare a down operation or describe why this migration is irreversible.',\n});\n`,
      { flag: "wx" },
    );
    return relative(root, file);
  }
  const dir = join(base, id);
  await mkdir(dir);
  await writeFile(
    join(dir, "migration.json"),
    `${JSON.stringify({ formatVersion: 1, id, transaction: "required", up: "up.sql", irreversibleReason: "Declare a down operation or explain irreversibility." }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(join(dir, "up.sql"), "-- Write reviewed SQL here\n", { flag: "wx" });
  return relative(root, dir);
}
