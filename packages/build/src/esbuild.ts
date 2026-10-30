import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plugin } from "esbuild";
import { BuildError, BuildSession } from "./engine.js";
import { inlineMap } from "./maps.js";
import type { BuildOptions } from "./project.js";

export function typedSql(options: BuildOptions = {}): Plugin {
  return {
    name: "typed-sql",
    setup(build) {
      const session = new BuildSession({
        ...options,
        cwd: options.cwd ?? build.initialOptions.absWorkingDir ?? process.cwd(),
      });
      build.onLoad({ filter: /\.(sql|[cm]?tsx?)$/ }, async (args) => {
        if (!session.accepts(args.path)) return;
        const project = await session.project();
        const source = await readFile(args.path, "utf8");
        try {
          const result = await session.transform(source, args.path);
          if (result === null) return;
          return {
            contents: inlineMap(result.code, result.map),
            loader: result.language,
            resolveDir: dirname(args.path),
            watchFiles: [...result.dependencies, args.path],
          };
        } catch (error) {
          if (!(error instanceof BuildError)) throw error;
          return {
            errors: error.diagnostics.map((item) => ({
              text: `${item.code}: ${item.message}`,
              location: {
                file: item.file,
                line: item.line,
                column: Buffer.byteLength(source.split("\n")[item.line - 1]!.slice(0, item.column - 1)),
                length: 1,
                lineText: source.split("\n")[item.line - 1]!,
              },
            })),
            watchFiles: [...project.watchedFiles, args.path],
          };
        }
      });
    },
  };
}
export default typedSql;
