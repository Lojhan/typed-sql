import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { type ConfigImporter, type LoadedConfig, loadConfigSource, resolveConfigDialect } from "@typed-sql/config";
import type { DialectPlugin, SchemaSnapshot } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";

import type { BuildAnalysis } from "./analysis-project.js";

const analyses = new WeakMap<
  BuildProject,
  { analysis: BuildAnalysis; dependencies: number; assertCurrent(): Promise<void>; reload(): Promise<BuildProject> }
>();

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
  const source = await loadConfigSource({
    cwd,
    ...(config === undefined ? {} : { file: config }),
    ...(importer === undefined ? {} : { importer }),
  });
  const schemaFile = resolve(source.directory, source.config.schema.file);
  const schemaText = await readFile(schemaFile, "utf8");
  const snapshot = source.config.dialect.validateSnapshot(JSON.parse(schemaText));
  const analysis =
    source.config.analysis === undefined
      ? undefined
      : await (await import("./analysis-project.js")).loadBuildAnalysis(source, snapshot);
  const loaded = analysis?.loaded ?? (await resolveConfigDialect(source));
  const directory = dirname(await realpath(loaded.file));
  const optionalManifest = analysis?.files.length === 1 ? analysis.files[0] : undefined;
  const watchedFiles = [
    ...new Set(
      await Promise.all(
        [...(loaded.dependencies ?? [loaded.file]), schemaFile, ...(analysis?.files ?? [])].map(async (file) => {
          try {
            return await realpath(file);
          } catch (error) {
            if (
              analysis &&
              file === optionalManifest &&
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return resolve(file);
            throw error;
          }
        }),
      ),
    ),
  ].sort();
  const contents = await Promise.all(
    watchedFiles.map(async (file) => {
      try {
        return await readFile(file, "utf8");
      } catch (error) {
        if (
          analysis &&
          file === optionalManifest &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    }),
  );
  if (contents[watchedFiles.indexOf(await realpath(schemaFile))] !== schemaText)
    throw new Error("Build schema inputs changed; retry building");
  const dialect = loaded.config.dialect;
  const hash = createHash("sha256")
    .update(dialect.id)
    .update("\0")
    .update(dialect.grammarVersion)
    .update("\0")
    .update(calculateTypePolicyHash(loaded.config.typePolicy ?? dialect.defaultTypePolicy));
  for (const [index, file] of watchedFiles.entries())
    hash
      .update("\0")
      .update(relative(directory, file).replaceAll("\\", "/"))
      .update("\0")
      .update(contents[index] === null ? "missing" : `present:${contents[index]}`);
  const project = { loaded, snapshot: analysis?.schema ?? snapshot, watchedFiles, configIdentity: hash.digest("hex") };
  if (analysis) {
    const assertCurrent = async () => {
      if ((await loadConfigSource({ file: source.file, ...(importer ? { importer } : {}) })) !== source)
        throw new Error("Build configuration inputs changed; retry building");
      for (const [index, file] of watchedFiles.entries()) {
        let current: string | null;
        try {
          current = await readFile(file, "utf8");
        } catch (error) {
          if (
            contents[index] === null &&
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
            current = null;
          else throw error;
        }
        if (current !== contents[index]) throw new Error("Build inputs changed; retry building");
      }
    };
    analyses.set(project, {
      analysis,
      dependencies: source.dependencies?.length ?? 0,
      assertCurrent,
      reload: () => loadBuildProject(cwd, config, importer),
    });
    await analysis.assertCurrent();
    await assertCurrent();
  }
  return project;
}

/** Internal source preparation shared by transforms, declaration generation and source-aware cache keys. */
export async function prepareBuildSource(
  project: BuildProject,
  source: string,
  id: string,
  options: { readonly deferInputChecks?: boolean } = {},
): Promise<{ project: BuildProject; dialect: DialectPlugin; assertCurrent?: () => Promise<void> }> {
  const state = analyses.get(project);
  if (!state) return { project, dialect: project.loaded.config.dialect };
  const view = await state.analysis.prepare(source, id);
  if (!options.deferInputChecks) await state.assertCurrent();
  const refreshed = (project.loaded.dependencies?.length ?? 0) === state.dependencies ? project : await state.reload();
  const assertCurrent =
    refreshed === project
      ? state.assertCurrent
      : async () => {
          await state.assertCurrent();
          await analyses.get(refreshed)?.assertCurrent();
        };
  if (!options.deferInputChecks) await assertCurrent();
  return { project: refreshed, dialect: view.dialect, assertCurrent };
}
