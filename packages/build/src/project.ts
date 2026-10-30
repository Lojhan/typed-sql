import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { type ConfigImporter, type LoadedConfig, loadConfig } from "@typed-sql/config";
import type { SchemaSnapshot } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";

export interface BuildOptions {
  /** Project directory. Defaults to the host root or process.cwd(). */
  readonly cwd?: string;
  /** Config path relative to cwd. Otherwise uses normal config discovery. */
  readonly config?: string;
  /** Transform inline TypeScript queries as well as SQL files. Defaults to true. */
  readonly inline?: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Maximum retained transformed modules, bounded further by a 32 MiB byte ceiling. */
  readonly cacheSize?: number;
  /** Deadline for synchronous transformer worker requests. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export interface BuildProject {
  readonly loaded: LoadedConfig;
  readonly snapshot: SchemaSnapshot;
  readonly watchedFiles: readonly string[];
  readonly configIdentity: string;
}

/** Build-time only: reads a saved snapshot and never invokes a schema provider. */
export async function loadBuildProject(
  cwd = process.cwd(),
  config?: string,
  importer?: ConfigImporter,
): Promise<BuildProject> {
  const loaded = await loadConfig({
    cwd,
    ...(config === undefined ? {} : { file: config }),
    ...(importer === undefined ? {} : { importer }),
  });
  const schemaFile = resolve(loaded.directory, loaded.config.schema.file);
  const directory = dirname(await realpath(loaded.file));
  const watchedFiles = [
    ...new Set(
      await Promise.all([...(loaded.dependencies ?? [loaded.file]), schemaFile].map((file) => realpath(file))),
    ),
  ].sort();
  const contents = await Promise.all(watchedFiles.map((file) => readFile(file, "utf8")));
  const snapshot = loaded.config.dialect.validateSnapshot(
    JSON.parse(contents[watchedFiles.indexOf(await realpath(schemaFile))]!),
  );
  const dialect = loaded.config.dialect;
  const hash = createHash("sha256")
    .update(dialect.id)
    .update("\0")
    .update(dialect.grammarVersion)
    .update("\0")
    .update(calculateTypePolicyHash(loaded.config.typePolicy ?? dialect.defaultTypePolicy));
  for (const [index, file] of watchedFiles.entries())
    hash.update("\0").update(relative(directory, file).replaceAll("\\", "/")).update("\0").update(contents[index]!);
  return { loaded, snapshot, watchedFiles, configIdentity: hash.digest("hex") };
}
