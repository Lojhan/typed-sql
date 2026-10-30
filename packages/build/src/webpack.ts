import { fileURLToPath } from "node:url";
import type { LoaderOptions } from "./loader.js";

export interface BuildWebpackCompiler {
  readonly options: { module?: { rules?: unknown[] } };
}

export class TypedSqlPlugin {
  readonly #options: LoaderOptions;
  constructor(options: LoaderOptions = {}) {
    this.#options = options;
  }
  apply(compiler: BuildWebpackCompiler): void {
    compiler.options.module ??= {};
    compiler.options.module.rules ??= [];
    compiler.options.module.rules.unshift({
      test: /\.(?:sql|[cm]?tsx?)$/u,
      enforce: "pre",
      use: [{ loader: fileURLToPath(new URL("./webpack-loader.cjs", import.meta.url)), options: this.#options }],
    });
  }
}
export function typedSql(options: LoaderOptions = {}): TypedSqlPlugin {
  return new TypedSqlPlugin(options);
}
export default typedSql;
