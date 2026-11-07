import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SqlRenderer } from "@typed-sql/core";
import { captureMigration, hashBytes, inventoryFiles, type MigrationDefinition, safePath } from "@typed-sql/migrations";
import { parse } from "acorn";
import { transform } from "esbuild";

export interface ExplorerLocalMigration {
  readonly id: string;
  readonly description?: string;
  readonly files: readonly string[];
  readonly hash?: string;
  readonly message?: string;
}
async function read(root: string, file: string): Promise<string> {
  const path = await realpath(await safePath(root, file));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const canonical = await realpath(path);
    const current = await lstat(canonical);
    const info = await handle.stat();
    if (
      canonical !== path ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      !info.isFile() ||
      info.size > 1024 * 1024
    )
      throw new TypeError("Migration metadata changed or exceeds 1 MiB");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= 1024 * 1024) {
      const bytes = Buffer.alloc(Math.min(65536, 1024 * 1024 + 1 - length));
      const part = await handle.read(bytes);
      if (!part.bytesRead) break;
      length += part.bytesRead;
      chunks.push(bytes.subarray(0, part.bytesRead));
    }
    if (length > 1024 * 1024) throw new TypeError("Migration metadata exceeds 1 MiB");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function staticTypeScriptMetadata(source: string): Promise<{ id: string; description?: string } | undefined> {
  // With no output-format conversion, esbuild strips TS syntax while preserving export-default AST.
  const transformed = await transform(source, { loader: "ts", target: "esnext", logLevel: "silent" });
  const program = parse(transformed.code, { ecmaVersion: "latest", sourceType: "module" });
  const bindings = new Set<string>();
  for (const statement of program.body)
    if (statement.type === "ImportDeclaration" && statement.source.value === "@typed-sql/migrations") {
      for (const specifier of statement.specifiers)
        if (
          specifier.type === "ImportSpecifier" &&
          ((specifier.imported.type === "Identifier" && specifier.imported.name === "defineMigration") ||
            (specifier.imported.type === "Literal" && specifier.imported.value === "defineMigration"))
        )
          bindings.add(specifier.local.name);
    }
  const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
  if (exported?.type !== "ExportDefaultDeclaration") return undefined;
  const declaration = exported.declaration;
  const definition =
    declaration.type === "ObjectExpression"
      ? declaration
      : declaration.type === "CallExpression" &&
          declaration.callee.type === "Identifier" &&
          bindings.has(declaration.callee.name) &&
          declaration.arguments.length === 1 &&
          declaration.arguments[0]?.type === "ObjectExpression"
        ? declaration.arguments[0]
        : undefined;
  if (!definition || definition.properties.some((property) => property.type !== "Property" || property.computed))
    return undefined;
  const values = new Map<string, unknown>();
  for (const property of definition.properties) {
    if (property.type !== "Property") return undefined;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? property.key.value
          : undefined;
    if (key !== "id" && key !== "description") continue;
    if (
      values.has(key) ||
      property.kind !== "init" ||
      property.value.type !== "Literal" ||
      typeof property.value.value !== "string"
    )
      return undefined;
    values.set(key, property.value.value);
  }
  const id = values.get("id");
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,180}$/u.test(id)) return undefined;
  const description = values.get("description");
  return { id, ...(typeof description === "string" ? { description } : {}) };
}
/** Reads immutable SQL manifests only. TypeScript migration modules are never imported or evaluated. */
export async function explorerMigrationInventory(
  root: string,
  directory: string,
  renderer: SqlRenderer,
): Promise<readonly ExplorerLocalMigration[]> {
  const inventory = await inventoryFiles(root, directory);
  if (Object.keys(inventory).length > 5000) throw new TypeError("Migration explorer inventory exceeds 5000 files");
  const entries: ExplorerLocalMigration[] = [];
  for (const file of Object.keys(inventory).sort()) {
    if (/(?:^|[\\/])[^/\\]+\.migration\.[cm]?ts$/u.test(file)) {
      let metadata: { id: string; description?: string } | undefined;
      try {
        metadata = await staticTypeScriptMetadata(await read(root, file));
      } catch {
        /* Syntax or dynamic metadata stays unverified. */
      }
      entries.push({
        id: metadata?.id ?? `file:${file}`,
        ...(metadata?.description === undefined ? {} : { description: metadata.description }),
        files: [file.split(sep).join("/")],
        message:
          "TypeScript migration ID metadata is static; its executable definition and hash remain unverified. The explorer never executes migration modules.",
      });
      continue;
    }
    if (!file.endsWith(`${sep}migration.json`) && file !== "migration.json") continue;
    try {
      const source = await read(root, file);
      const metadata = JSON.parse(source) as MigrationDefinition & {
        formatVersion?: unknown;
        up?: unknown;
        down?: unknown;
      };
      if (metadata.formatVersion !== 1 || typeof metadata.id !== "string" || typeof metadata.up !== "string")
        throw new TypeError("Invalid migration manifest");
      const hashes: Record<string, string> = { [file]: hashBytes(source) };
      const asset = async (name: unknown): Promise<string> => {
        if (typeof name !== "string" || isAbsolute(name)) throw new TypeError("Migration SQL paths must be strings");
        const folder = dirname(resolve(root, file));
        const path = await safePath(folder, name);
        const text = await read(root, relative(root, path));
        hashes[relative(root, path)] = hashBytes(text);
        return text;
      };
      const up = await asset(metadata.up);
      const down = metadata.down === undefined ? undefined : await asset(metadata.down);
      const captured = captureMigration(
        { ...metadata, up: [up], ...(down === undefined ? {} : { down: [down] }) },
        hashes,
        renderer,
      );
      entries.push({
        id: captured.id,
        description: captured.description,
        hash: captured.hash,
        files: Object.keys(hashes)
          .map((path) => path.split(sep).join("/"))
          .sort(),
      });
    } catch {
      entries.push({
        id: `file:${file}`,
        files: [file.split(sep).join("/")],
        message: "Migration metadata could not be verified. Inspect its manifest and SQL asset paths.",
      });
    }
  }
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  return entries.map((entry) => {
    if (counts.get(entry.id)! <= 1) return entry;
    const { hash: _hash, ...unverified } = entry;
    return { ...unverified, message: "Multiple migration manifests declare this ID; pending status is unverified." };
  });
}
