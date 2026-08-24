import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DIALECT_CONTRACT_VERSION,
  type SchemaSnapshot,
  type TypedSqlConfig,
} from "@typed-sql/core";
import { tsImport } from "tsx/esm/api";

const configNames = [
  "typed-sql.config.ts",
  "typed-sql.config.mts",
  "typed-sql.config.mjs",
  "typed-sql.config.js",
] as const;

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
  return candidate.dialect?.contractVersion === DIALECT_CONTRACT_VERSION
    && typeof candidate.dialect.id === "string"
    && typeof candidate.dialect.sqlModule === "string"
    && typeof candidate.dialect.analyze === "function"
    && typeof candidate.dialect.validateSnapshot === "function"
    && typeof candidate.schema?.file === "string"
    && typeof candidate.outDir === "string";
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const file = options.file === undefined
    ? await discoverConfig(options.cwd)
    : resolve(options.cwd ?? process.cwd(), options.file);
  const module = await tsImport(pathToFileURL(file).href, pathToFileURL(join(dirname(file), "package.json")).href) as { readonly default?: unknown };
  if (!isConfig(module.default)) throw new TypeError(`${file} must default-export defineConfig({...})`);
  return { file, directory: dirname(file), config: module.default };
}

export function fromConfig(directory: string, path: string): string {
  return resolve(directory, path);
}
