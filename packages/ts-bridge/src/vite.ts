import { readFile } from "node:fs/promises";
import { compileSource } from "@typed-sql/compiler";
import { analyzeSqlFile, loadSqlFileProject } from "./sql-file.js";

/** Build-time integration only. Generated modules contain static SQL and value plans. */
export function typedSql(options: { readonly config?: string } = {}) {
  let root = process.cwd();
  const project = () => loadSqlFileProject(root, options.config);
  const report = (
    file: string,
    diagnostics: readonly {
      readonly message: string;
      readonly range: { readonly line: number; readonly column: number };
    }[],
  ) => {
    if (diagnostics.length > 0)
      throw new Error(
        diagnostics.map((item) => `${file}:${item.range.line}:${item.range.column}: ${item.message}`).join("\n"),
      );
  };
  return {
    name: "typed-sql",
    enforce: "pre" as const,
    configResolved(config: { readonly root: string }) {
      root = config.root;
    },
    async load(this: { addWatchFile(file: string): void }, id: string): Promise<string | null> {
      if (!id.endsWith(".sql")) return null;
      const loaded = await project();
      for (const file of loaded.watchedFiles) this.addWatchFile(file);
      const result = analyzeSqlFile(await readFile(id, "utf8"), loaded);
      if (result.diagnostics.length > 0)
        throw new Error(result.diagnostics.map((item) => `${id}:${item.start}: ${item.messageText}`).join("\n"));
      return result.runtime;
    },
    async transform(
      this: { addWatchFile(file: string): void },
      code: string,
      id: string,
    ): Promise<{ code: string; map: null } | null> {
      if (!/\.[cm]?tsx?$/u.test(id) || id.includes("/node_modules/") || !code.includes("@typed-sql/")) return null;
      const loaded = await project();
      for (const file of loaded.watchedFiles) this.addWatchFile(file);
      const result = compileSource({
        source: code,
        dialect: loaded.loaded.config.dialect,
        schema: loaded.snapshot,
        typePolicy: loaded.loaded.config.typePolicy ?? loaded.loaded.config.dialect.defaultTypePolicy,
        runtimeMetadata: true,
      });
      report(
        id,
        result.diagnostics.filter((item) => item.severity === "error"),
      );
      if (result.queries.some((query) => query.valuePlan === undefined))
        throw new Error(
          `${id}: this query structure has no executable value plan; use a static query for portable adapters`,
        );
      return result.transformedSource === code ? null : { code: result.transformedSource, map: null };
    },
  };
}
