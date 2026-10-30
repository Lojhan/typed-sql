import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { BuildSession, type BuildSourceMap } from "./engine.js";
import { identityMap, javascript } from "./maps.js";
import type { BuildOptions } from "./project.js";

interface WatchContext {
  addWatchFile(file: string): void;
}
export interface BuildPlugin {
  readonly name: string;
  resolveId(source: string, importer?: string): Promise<string | null>;
  buildStart(this: WatchContext): Promise<void>;
  shouldTransformCachedModule(): boolean;
  load(this: WatchContext, id: string): Promise<{ code: string; map: BuildSourceMap } | null>;
  transform(this: WatchContext, source: string, id: string): Promise<{ code: string; map: BuildSourceMap } | null>;
}

export function buildPlugin(
  options: BuildOptions = {},
  transpile = false,
): { plugin: BuildPlugin; setRoot(root: string): void; dependencies(): readonly string[] } {
  let session = new BuildSession(options);
  let dependencies: readonly string[] = [];
  let identity: string | undefined;
  let changed = true;
  const watch = async (context: WatchContext) => {
    const current = await session.identity();
    dependencies = current.dependencies;
    for (const file of dependencies) context.addWatchFile(file);
    return current.key;
  };
  return {
    setRoot(root) {
      session = new BuildSession({ ...options, cwd: options.cwd ?? root });
    },
    dependencies: () => dependencies,
    plugin: {
      name: "typed-sql",
      async resolveId(source, importer) {
        if (!source.endsWith(".sql") || source.includes("?") || source.includes("\0")) return null;
        if (!isAbsolute(source) && (!source.startsWith(".") || importer === undefined || importer.includes("\0")))
          return null;
        const file = isAbsolute(source) ? source : resolve(dirname(importer!), source);
        if (!session.accepts(file)) return null;
        try {
          return (await stat(file)).isFile() ? file : null;
        } catch (error) {
          if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
      },
      async buildStart() {
        const next = await watch(this);
        changed = identity !== next;
        identity = next;
      },
      shouldTransformCachedModule: () => changed,
      async load(id) {
        if (!id.endsWith(".sql") || !session.accepts(id)) return null;
        await watch(this);
        const result = await session.transform(await readFile(id, "utf8"), id);
        return result === null ? null : { code: result.code, map: result.map };
      },
      async transform(source, id) {
        if (id.endsWith(".sql") || !session.accepts(id)) return null;
        let result: Awaited<ReturnType<BuildSession["transform"]>>;
        try {
          result = await session.transform(source, id);
        } catch (error) {
          await watch(this);
          throw error;
        }
        if (result !== null) {
          dependencies = result.dependencies;
          for (const file of dependencies) this.addWatchFile(file);
        }
        if (transpile) return javascript(result?.code ?? source, id, result?.map ?? identityMap(source, id));
        return result === null ? null : { code: result.code, map: result.map };
      },
    },
  };
}

export function watchedDependency(files: readonly string[], file: string): boolean {
  return files.some((entry) => resolve(entry) === resolve(file));
}
