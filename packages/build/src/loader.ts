import { BuildSession, type BuildSourceMap } from "./engine.js";
import { composeMaps, identityMap, javascript } from "./maps.js";
import type { BuildOptions } from "./project.js";

export interface LoaderOptions extends BuildOptions {
  readonly transpile?: boolean;
}
export interface LoaderContext {
  readonly resourcePath: string;
  readonly rootContext: string;
  getOptions(): LoaderOptions;
  addDependency(file: string): void;
  async(): (error: Error | null, code?: string, map?: BuildSourceMap) => void;
}

export async function transformLoader(
  context: LoaderContext,
  source: string,
  input?: BuildSourceMap,
): Promise<{ code: string; map?: BuildSourceMap }> {
  const options = context.getOptions();
  const session = new BuildSession({ ...options, cwd: options.cwd ?? context.rootContext });
  if (!session.accepts(context.resourcePath)) return { code: source, ...(input === undefined ? {} : { map: input }) };
  const project = await session.project();
  for (const file of project.watchedFiles) context.addDependency(file);
  const result = await session.transform(source, context.resourcePath);
  if (result === null) {
    if (options.transpile !== false && !context.resourcePath.endsWith(".sql"))
      return javascript(source, context.resourcePath, input ?? identityMap(source, context.resourcePath));
    return { code: source, ...(input === undefined ? {} : { map: input }) };
  }
  const map = composeMaps(result.map, input);
  if (result.language !== "js" && options.transpile !== false)
    return javascript(result.code, context.resourcePath, map);
  return { code: result.code, map };
}
