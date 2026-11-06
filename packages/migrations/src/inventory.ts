import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SqlRenderer } from "@typed-sql/core";
import { tsImport } from "tsx/esm/api";
import { digest, hashBytes, MigrationError, object } from "./codec.js";
import { captureMigration } from "./definition.js";
import type { CapturedMigration, MigrationDefinition } from "./types.js";

const limit = 2 * 1024 * 1024;
async function readBounded(file: string): Promise<string> {
  const invalid = () =>
    new MigrationError("MIGRATION_FILE", "Migration inputs must be regular files no larger than 2 MiB.");
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") throw invalid();
    throw error;
  }
  try {
    // Inspect and read the same descriptor: replacing the path cannot redirect the read.
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw invalid();
    // Bound the read itself as well: the opened file can grow after fstat.
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limit) throw invalid();
    return bytes.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
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
  let fileCount = 0;
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = await safePath(root, join(path, entry.name));
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:json|sql|[cm]?ts)$/u.test(entry.name)) {
        if (fileCount++ >= 10000)
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
  migrations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  sqlModule?: string,
  templateDirectory?: string,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,79}$/u.test(name))
    throw new MigrationError("MIGRATION_NAME", "Use a lowercase migration name with letters, numbers and hyphens.");
  const id = `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}_${randomBytes(3).toString("hex")}_${name}`;
  const base = resolve(root, directory);
  await safePath(root, base);
  const template = async (filename: string): Promise<string | undefined> => {
    if (templateDirectory === undefined) return undefined;
    const dir = await safePath(root, templateDirectory);
    try {
      return (await readBounded(await safePath(dir, filename)))
        .replaceAll("{{id}}", id)
        .replaceAll("{{name}}", name)
        .replaceAll("{{sqlModule}}", JSON.stringify(sqlModule ?? ""));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  if (format === "ts") {
    if (sqlModule === undefined || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/iu.test(sqlModule))
      throw new MigrationError("MIGRATION_SQL_MODULE", "TypeScript authoring requires the selected grammar sqlModule.");
    const file = join(base, `${id}.migration.ts`);
    await writeFile(
      file,
      (await template("migration.ts")) ??
        `import { sql } from ${JSON.stringify(sqlModule)};\nimport { defineMigration } from '@typed-sql/migrations';\n\nexport default defineMigration({\n  id: '${id}',\n  transaction: 'required',\n  up: [sql\`-- Write reviewed SQL here\`],\n  irreversibleReason: 'Declare a down operation or describe why this migration is irreversible.',\n});\n`,
      { flag: "wx" },
    );
    return relative(root, file);
  }
  const up = (await template("up.sql")) ?? "-- Write reviewed SQL here\n",
    down = await template("down.sql");
  const metadataSource = await template("migration.json");
  const metadata =
    metadataSource === undefined ? {} : object(JSON.parse(metadataSource), "Migration template metadata");
  if (
    Object.keys(metadata).some(
      (key) => !["description", "transaction", "checks", "irreversibleReason", "reconciliation"].includes(key),
    )
  )
    throw new MigrationError(
      "MIGRATION_TEMPLATE",
      "Template metadata may define description, transaction, checks, irreversibility and reconciliation only; IDs and asset paths are generated.",
    );
  const dir = join(base, id),
    staging = await mkdtemp(join(base, ".new-"));
  try {
    await writeFile(
      join(staging, "migration.json"),
      `${JSON.stringify({ transaction: "required", irreversibleReason: "Declare a down operation or explain irreversibility.", ...metadata, formatVersion: 1, id, up: "up.sql", ...(down === undefined ? {} : { down: "down.sql" }) }, null, 2)}\n`,
      { flag: "wx" },
    );
    await writeFile(join(staging, "up.sql"), up, { flag: "wx" });
    if (down !== undefined) await writeFile(join(staging, "down.sql"), down, { flag: "wx" });
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return relative(root, dir);
}
