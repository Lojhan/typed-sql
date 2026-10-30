import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { compileSource, compileSqlFile } from "@typed-sql/compiler";
import MagicString from "magic-string";
import picomatch from "picomatch";
import { type BuildOptions, type BuildProject, loadBuildProject } from "./project.js";
import version from "./version.cjs";

export interface BuildSourceMap {
  readonly version: 3;
  readonly file?: string;
  readonly sources: string[];
  readonly sourcesContent?: (string | null)[];
  readonly names: string[];
  readonly mappings: string;
}

export interface BuildDiagnostic {
  readonly file: string;
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export class BuildError extends Error {
  readonly code = "TYPED_SQL_BUILD";
  readonly diagnostics: readonly BuildDiagnostic[];
  constructor(diagnostics: readonly BuildDiagnostic[]) {
    super(
      diagnostics.map((item) => `${item.file}:${item.line}:${item.column}: ${item.code}: ${item.message}`).join("\n"),
    );
    this.name = "BuildError";
    this.diagnostics = diagnostics;
  }
}

export interface BuildResult {
  readonly code: string;
  readonly map: BuildSourceMap;
  readonly dependencies: readonly string[];
  readonly cacheKey: string;
  readonly language: "js" | "ts" | "tsx";
}

const defaultExclude = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/dist/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/*.d.sql.ts",
  "**/*.d.mts",
  "**/*.d.cts",
];
const defaultInclude = ["**/*.sql", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];
function canonicalPath(file: string): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(file);
    return parent === file ? file : resolve(canonicalPath(parent), basename(file));
  }
}

const maximumCacheBytes = 32 * 1024 * 1024;

/** One session per host project, with a bounded cache keyed by every compiler input. */
export class BuildSession {
  readonly options: BuildOptions;
  readonly cwd: string;
  readonly #include: (file: string) => boolean;
  readonly #exclude: (file: string) => boolean;
  readonly #cache = new Map<string, { result: BuildResult; bytes: number }>();
  readonly #cacheSize: number;
  readonly #project: BuildProject | undefined;
  #cacheBytes = 0;

  constructor(options: BuildOptions = {}, project?: BuildProject) {
    this.#project = project;
    this.options = options;
    this.cwd = canonicalPath(resolve(options.cwd ?? process.cwd()));
    this.#cacheSize = options.cacheSize ?? 64;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize < 0 || this.#cacheSize > 1024)
      throw new RangeError("cacheSize must be an integer from 0 through 1024");
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)
    )
      throw new RangeError("timeoutMs must be an integer from 1 through 120000");
    this.#include = picomatch([...(options.include ?? defaultInclude)], { dot: true });
    this.#exclude = picomatch([...(options.exclude ?? defaultExclude)], { dot: true });
  }

  accepts(id: string): boolean {
    if (id.includes("\0") || id.includes("?") || !/\.(?:sql|[cm]?tsx?)$/u.test(id)) return false;
    const path = relative(this.cwd, canonicalPath(resolve(id))).replaceAll("\\", "/");
    return this.#include(path) && !this.#exclude(path);
  }

  project(): Promise<BuildProject> {
    return this.#project === undefined
      ? loadBuildProject(this.cwd, this.options.config)
      : Promise.resolve(this.#project);
  }

  async identity(): Promise<{ key: string; dependencies: readonly string[] }> {
    const project = await this.project();
    return { key: `typed-sql-build:1:${version}:${project.configIdentity}`, dependencies: project.watchedFiles };
  }

  async transform(source: string, id: string): Promise<BuildResult | null> {
    if (!this.accepts(id) || (this.options.inline === false && !id.endsWith(".sql"))) return null;
    if (!id.endsWith(".sql") && !source.includes("`") && !/\.(?:append|where)\s*\(/u.test(source)) return null;
    const project = await this.project();
    const key = createHash("sha256")
      .update(`typed-sql-build:1:${version}:${project.configIdentity}\0${id}\0`)
      .update(source)
      .digest("hex");
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.result;
    }
    const { dialect, typePolicy } = project.loaded.config;
    const mapped = new MagicString(source);
    let language: BuildResult["language"] = id.endsWith(".tsx") ? "tsx" : "ts";
    if (id.endsWith(".sql")) {
      const analysis = compileSqlFile({
        source,
        dialect,
        schema: project.snapshot,
        ...(typePolicy === undefined ? {} : { typePolicy }),
      });
      if (analysis.diagnostics.length > 0)
        throw new BuildError(
          analysis.diagnostics.map((item) => {
            const prefix = source.slice(0, item.start);
            return {
              file: id,
              code: `TSQ${item.code}`,
              message: item.messageText.replace(/^TSQ\d+:\s*/u, ""),
              line: prefix.split("\n").length,
              column: prefix.length - prefix.lastIndexOf("\n"),
            };
          }),
        );
      mapped.overwrite(0, source.length, analysis.runtime);
      language = "js";
    } else {
      const compilation = compileSource({
        source,
        dialect,
        schema: project.snapshot,
        ...(typePolicy === undefined ? {} : { typePolicy }),
        runtimeMetadata: true,
      });
      const errors = compilation.diagnostics.filter((item) => item.severity === "error");
      if (errors.length > 0)
        throw new BuildError(
          errors.map((item) => ({
            file: id,
            code: item.code,
            message: item.message,
            line: item.range.line,
            column: item.range.column,
          })),
        );
      if (compilation.transformedSource === source) return null;
      for (const insertion of compilation.insertions) mapped.prependLeft(insertion.position, insertion.text);
      if (mapped.toString() !== compilation.transformedSource)
        throw new Error("Compiler insertion map does not reproduce the transformed source");
    }
    const map = JSON.parse(
      mapped.generateMap({ source: id, file: id, includeContent: true, hires: true }).toString(),
    ) as BuildSourceMap;
    const result: BuildResult = {
      code: mapped.toString(),
      map,
      dependencies: project.watchedFiles,
      cacheKey: key,
      language,
    };
    const bytes = Buffer.byteLength(result.code) + Buffer.byteLength(JSON.stringify(map));
    if (this.#cacheSize > 0 && bytes <= maximumCacheBytes) {
      while (this.#cache.size >= this.#cacheSize || this.#cacheBytes + bytes > maximumCacheBytes) {
        const first = this.#cache.entries().next().value;
        if (first === undefined) break;
        this.#cache.delete(first[0]);
        this.#cacheBytes -= first[1].bytes;
      }
      this.#cache.set(key, { result, bytes });
      this.#cacheBytes += bytes;
    }
    return result;
  }
}
