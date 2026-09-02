import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertDialectPlugin, type SchemaSnapshot, type TypedSqlConfig } from "@typed-sql/core";
import { register } from "tsx/esm/api";

const configNames = [
  "typed-sql.config.ts",
  "typed-sql.config.mts",
  "typed-sql.config.mjs",
  "typed-sql.config.js",
] as const;
const CONFIG_CACHE_LIMIT = 32;
const configLoader = register({ namespace: "typed-sql-config" });
const configCache = new Map<string, Promise<LoadedConfig>>();

export interface LoadedConfig {
  readonly file: string;
  readonly directory: string;
  readonly config: TypedSqlConfig<SchemaSnapshot, unknown>;
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
      const candidate = join(directory, name);
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
  const source = await readFile(file);
  const hash = createHash("sha256").update(source).digest("hex");
  const key = `${file}\0${hash}`;
  const cached = configCache.get(key);
  if (cached !== undefined) {
    configCache.delete(key);
    configCache.set(key, cached);
    return cached;
  }
  const specifier = new URL(pathToFileURL(file));
  specifier.searchParams.set("typed-sql-config", hash);
  const loading = configLoader
    .import(specifier.href, pathToFileURL(join(dirname(file), "package.json")).href)
    .then((module: { readonly default?: unknown }) => {
      if (!isConfig(module.default)) throw new TypeError(`${file} must default-export defineConfig({...})`);
      return { file, directory: dirname(file), config: module.default };
    })
    .catch((error: unknown) => {
      configCache.delete(key);
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
