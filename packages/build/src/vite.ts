import { type BuildPlugin, buildPlugin, watchedDependency } from "./plugin.js";
import type { BuildOptions } from "./project.js";

export interface ViteBuildPlugin extends BuildPlugin {
  readonly enforce: "pre";
  configResolved(config: { readonly root: string }): void;
  handleHotUpdate(context: {
    readonly file: string;
    readonly server: {
      readonly moduleGraph: { invalidateAll(): void };
      readonly ws: { send(message: { readonly type: "full-reload" }): void };
    };
  }): [] | undefined;
}

/** Shared Vite/Vitest transform; runs before the host's TypeScript transpiler. */
export function typedSql(options: BuildOptions = {}): ViteBuildPlugin {
  const adapter = buildPlugin(options);
  return {
    ...adapter.plugin,
    enforce: "pre",
    configResolved(config) {
      adapter.setRoot(config.root);
    },
    handleHotUpdate(context) {
      if (!watchedDependency(adapter.dependencies(), context.file)) return;
      context.server.moduleGraph.invalidateAll();
      context.server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}

export default typedSql;
