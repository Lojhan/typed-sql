import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDialectPlugin, type SchemaSnapshot, type TypedSqlConfig } from "@typed-sql/core";
import { tsImport } from "tsx/esm/api";

const configNames = [
  "typed-sql.config.ts",
  "typed-sql.config.mts",
  "typed-sql.config.mjs",
  "typed-sql.config.js",
] as const;
export const CONFIG_CACHE_LIMIT = 32;
const configCache = new Map<string, Promise<LoadedConfig>>();
interface FileFingerprint {
  readonly identity: string;
  readonly hash: string;
}
const dependencyHashes = new WeakMap<LoadedConfig, Map<string, FileFingerprint>>();
const hashFile = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

async function fingerprint(file: string, previous?: FileFingerprint): Promise<FileFingerprint> {
  const info = await stat(file, { bigint: true });
  // ctime detects same-size edits even when tools restore mtime; inode detects replacement.
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  if (previous?.identity === identity) return previous;
  return { identity, hash: await hashFile(file) };
}

export interface LoadedConfig {
  readonly file: string;
  readonly directory: string;
  readonly config: TypedSqlConfig<SchemaSnapshot, unknown>;
  /** Local modules imported while evaluating this configuration, for editor file watchers. */
  readonly dependencies?: readonly string[];
}

export interface LoadConfigOptions {
  readonly file?: string;
  readonly cwd?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverConfig(start = process.cwd()): Promise<string> {
  let directory = resolve(start);
  while (true) {
    for (const name of configNames) {
      const candidate = resolve(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Could not find typed-sql.config.ts from ${start}`);
    directory = parent;
  }
}

function isConfig(value: unknown): value is TypedSqlConfig<SchemaSnapshot, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TypedSqlConfig<SchemaSnapshot, unknown>>;
  if (typeof candidate.schema?.file !== "string" || typeof candidate.outDir !== "string") return false;
  try {
    assertDialectPlugin(candidate.dialect);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const file =
    options.file === undefined
      ? await discoverConfig(options.cwd)
      : resolve(options.cwd ?? process.cwd(), options.file);
  const hash = await hashFile(file);
  const key = `${file}\0${hash}`;
  const cached = configCache.get(key);
  if (cached !== undefined) {
    const loaded = await cached;
    const fingerprints = dependencyHashes.get(loaded)!;
    const unchanged = await Promise.all(
      [...fingerprints].map(async ([path, previous]) => {
        try {
          const current = await fingerprint(path, previous);
          if (current.hash !== previous.hash) return false;
          fingerprints.set(path, current);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (configCache.get(key) !== cached) return loadConfig(options);
    configCache.delete(key);
    if (unchanged.every(Boolean)) {
      configCache.set(key, cached);
      return loaded;
    }
  }
  const dependencies = new Set<string>([file]);
  // A fresh tsx namespace reloads the entire imported module graph, not only the
  // entry module. Reuse is handled above once every recorded dependency matches.
  const loading = tsImport(pathToFileURL(file).href, {
    parentURL: import.meta.url,
    onImport(url) {
      if (!url.startsWith("file:")) return;
      const path = fileURLToPath(url);
      if (!path.split(sep).includes("node_modules")) dependencies.add(path);
    },
  })
    .then(async (module: { readonly default?: unknown }) => {
      if (!isConfig(module.default)) throw new TypeError(`${file} must default-export defineConfig({...})`);
      const paths = Object.freeze([...dependencies].sort());
      const loaded = { file, directory: dirname(file), config: module.default, dependencies: paths };
      dependencyHashes.set(
        loaded,
        // The entry file was already content-hashed above; avoid a duplicate read on cache hits.
        new Map(
          await Promise.all(
            paths.filter((path) => path !== file).map(async (path) => [path, await fingerprint(path)] as const),
          ),
        ),
      );
      return loaded;
    })
    .catch((error: unknown) => {
      if (configCache.get(key) === loading) configCache.delete(key);
      throw error;
    });
  configCache.set(key, loading);
  while (configCache.size > CONFIG_CACHE_LIMIT) {
    const oldest = configCache.keys().next().value;
    if (oldest === undefined) break;
    configCache.delete(oldest);
  }
  return loading;
}

export function fromConfig(directory: string, path: string): string {
  return resolve(directory, path);
}
