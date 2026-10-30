import { readFile } from "node:fs/promises";
import { importBunConfig } from "./bun-config.js";
import { BuildSession } from "./engine.js";
import { inlineMap } from "./maps.js";
import { type BuildOptions, loadBuildProject } from "./project.js";

export interface BunBuildPlugin {
  readonly name: string;
  setup(build: {
    onLoad(
      options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" | "ts" | "tsx" }> | undefined,
    ): void;
  }): void;
}

/** Native Bun plugin for Bun.build and registration through Bun's runtime plugin API. */
export async function typedSql(options: BuildOptions = {}): Promise<BunBuildPlugin> {
  // Load before Bun starts its parser: nested Bun.build calls from onLoad can deadlock.
  const project = await loadBuildProject(options.cwd, options.config, importBunConfig);
  const session = new BuildSession(options, project);
  return {
    name: "typed-sql",
    setup(build) {
      build.onLoad({ filter: /\.(?:sql|[cm]?tsx?)$/u }, ({ path }) => {
        if (!session.accepts(path)) return;
        return (async () => {
          const source = await readFile(path, "utf8");
          const result = await session.transform(source, path);
          return result === null
            ? { contents: source, loader: path.endsWith(".tsx") ? ("tsx" as const) : ("ts" as const) }
            : { contents: inlineMap(result.code, result.map), loader: result.language };
        })();
      });
    },
  };
}
export default typedSql;
