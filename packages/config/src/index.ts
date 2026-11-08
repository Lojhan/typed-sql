import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertDialectPlugin,
  assertDialectProfile,
  type SchemaSnapshot,
  type TypedSqlConfig,
  type TypedSqlConfigSource,
} from "@typed-sql/core";
import { tsImport } from "tsx/esm/api";

const configNames = [
  "typed-sql.config.ts",
  "typed-sql.config.mts",
  "typed-sql.config.mjs",
  "typed-sql.config.js",
] as const;
export const CONFIG_CACHE_LIMIT = 32;
const configCache = new Map<string, Promise<LoadedConfigSource>>();
interface FileFingerprint {
  readonly identity: string;
  readonly hash: string;
}
const dependencyHashes = new WeakMap<LoadedConfigSource, Map<string, FileFingerprint>>();
const discoveredDependencies = new WeakMap<LoadedConfigSource, Set<string>>();
const resolvedConfigs = new WeakMap<LoadedConfigSource, Promise<LoadedConfig>>();
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

export interface LoadedConfigSource extends Omit<LoadedConfig, "config"> {
  readonly config: TypedSqlConfigSource<SchemaSnapshot, unknown>;
}

/** Host loader must evaluate a fresh local graph and report imported file URLs. */
export type ConfigImporter = (file: string, onImport: (url: string) => void) => Promise<{ readonly default?: unknown }>;
const importerIds = new WeakMap<ConfigImporter, number>();
let nextImporterId = 1;
function importerIdentity(importer: ConfigImporter | undefined): number {
  if (importer === undefined) return 0;
  let id = importerIds.get(importer);
  if (id === undefined) {
    id = nextImporterId++;
    importerIds.set(importer, id);
  }
  return id;
}

export interface LoadConfigOptions {
  readonly file?: string;
  readonly cwd?: string;
  /** Runtime-specific module loader. Default: isolated tsx namespaces on Node.js. */
  readonly importer?: ConfigImporter;
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

function isConfig(value: unknown): value is TypedSqlConfigSource<SchemaSnapshot, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TypedSqlConfigSource<SchemaSnapshot, unknown>>;
  if (typeof candidate.schema?.file !== "string" || typeof candidate.outDir !== "string") return false;
  try {
    if (candidate.dialect && "analyze" in candidate.dialect) assertDialectPlugin(candidate.dialect);
    else {
      assertDialectProfile(candidate.dialect);
      if (candidate.dialect.loadAnalyzer !== undefined && typeof candidate.dialect.loadAnalyzer !== "function")
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function loadConfigSource(options: LoadConfigOptions = {}): Promise<LoadedConfigSource> {
  const file =
    options.file === undefined
      ? await discoverConfig(options.cwd)
      : resolve(options.cwd ?? process.cwd(), options.file);
  const hash = await hashFile(file);
  const key = `${importerIdentity(options.importer)}\0${file}\0${hash}`;
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
    if (configCache.get(key) !== cached) return loadConfigSource(options);
    configCache.delete(key);
    if (unchanged.every(Boolean)) {
      configCache.set(key, cached);
      return loaded;
    }
  }
  const dependencies = new Set<string>([file]);
  // A fresh tsx namespace reloads the entire imported module graph, not only the
  // entry module. Reuse is handled above once every recorded dependency matches.
  const onImport = (url: string) => {
    if (!url.startsWith("file:")) return;
    const path = fileURLToPath(url);
    if (!path.split(sep).includes("node_modules")) dependencies.add(path);
  };
  const loading = (
    options.importer === undefined
      ? tsImport(pathToFileURL(file).href, { parentURL: import.meta.url, onImport })
      : options.importer(file, onImport)
  )
    .then(async (module: { readonly default?: unknown }) => {
      if (!isConfig(module.default)) throw new TypeError(`${file} must default-export defineConfig({...})`);
      const paths = Object.freeze([...dependencies].sort());
      const loaded: LoadedConfigSource = {
        file,
        directory: dirname(file),
        config: module.default,
        get dependencies() {
          return Object.freeze([...dependencies].sort());
        },
      };
      discoveredDependencies.set(loaded, dependencies);
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

/** Explicit owner initialization. Raw/profile-only hosts never call this operation. */
export async function resolveConfigDialect(source: LoadedConfigSource): Promise<LoadedConfig> {
  const profile = source.config.dialect;
  if ("analyze" in profile) {
    assertDialectPlugin(profile);
    return source as LoadedConfig;
  }
  let pending = resolvedConfigs.get(source);
  if (!pending) {
    pending = (async () => {
      if (!profile.loadAnalyzer)
        throw new TypeError("This grammar registration has no offline analyzer; use an artifact-aware host.");
      const owner = await profile.loadAnalyzer();
      assertDialectPlugin(owner);
      for (const key of ["id", "grammarVersion", "sqlModule"] as const)
        if (owner[key] !== profile[key]) throw new TypeError(`Loaded analyzer ${key} differs from its grammar profile`);
      const tracked = dependencyHashes.get(source),
        paths = discoveredDependencies.get(source);
      if (tracked && paths)
        for (const path of paths)
          if (path !== source.file && !tracked.has(path)) tracked.set(path, await fingerprint(path));
      const dialect = Object.freeze({
        ...owner,
        ...profile,
        analyze: owner.analyze.bind(owner),
        ...(profile.runtimeValueType === undefined && owner.runtimeValueType !== undefined
          ? { runtimeValueType: owner.runtimeValueType.bind(owner) }
          : {}),
      });
      const config = Object.freeze({ ...source.config, dialect });
      return {
        ...source,
        config,
        get dependencies() {
          return source.dependencies ?? Object.freeze([]);
        },
      };
    })().catch((error: unknown) => {
      resolvedConfigs.delete(source);
      throw error;
    });
    resolvedConfigs.set(source, pending);
  }
  return pending;
}

/** Compatibility loader for callers requiring an initialized synchronous analyzer. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const source = await loadConfigSource(options);
  if (source.config.analysis !== undefined)
    throw new Error(
      "This host does not support analysis configurations; use an analysis-aware host such as typed-sql check --frozen.",
    );
  return resolveConfigDialect(source);
}

/** Explicit contribution construction, tracking newly imported local modules for future invalidation. */
export async function runConfigFactory<Output>(
  source: LoadedConfigSource,
  factory: () => Output | Promise<Output>,
  options: { readonly onDiscard?: (value: Output) => void | Promise<void> } = {},
): Promise<Output> {
  const [created] = await Promise.allSettled([Promise.resolve().then(factory)]);
  let trackingFailure: { readonly reason: unknown } | undefined;
  try {
    const tracked = dependencyHashes.get(source),
      paths = discoveredDependencies.get(source);
    if (tracked && paths)
      for (const path of paths)
        if (path !== source.file && !tracked.has(path)) tracked.set(path, await fingerprint(path));
  } catch (reason) {
    trackingFailure = { reason };
  }
  if (trackingFailure) {
    const errors = [...(created.status === "rejected" ? [created.reason] : []), trackingFailure.reason];
    if (created.status === "fulfilled" && options.onDiscard) {
      try {
        await options.onDiscard(created.value);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Configuration contribution and dependency tracking failed");
  }
  if (created.status === "rejected") throw created.reason;
  return created.value;
}

export function fromConfig(directory: string, path: string): string {
  return resolve(directory, path);
}
