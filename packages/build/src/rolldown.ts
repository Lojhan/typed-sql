import { type BuildPlugin, buildPlugin } from "./plugin.js";
import type { BuildOptions } from "./project.js";

export function typedSql(options: BuildOptions = {}): BuildPlugin {
  return buildPlugin(options).plugin;
}
export default typedSql;
