import type { BuildSourceMap } from "./engine.js";
import type { LoaderContext } from "./loader.js";

function loader(this: LoaderContext, source: string, map?: BuildSourceMap): void {
  const callback = this.async();
  void import("./loader.js")
    .then(({ transformLoader }) => transformLoader(this, source, map))
    .then(
      (result) => callback(null, result.code, result.map),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
}
export = loader;
