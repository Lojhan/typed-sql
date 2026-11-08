import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, it, strict } from "poku";
import { postgres } from "../../postgres/src/analysis.js";
import { postgresRenderer } from "../../postgres/src/runtime.js";
import { compileSource } from "../src/index.js";

const dialect = postgres();
const schema = dialect.validateSnapshot(
  JSON.parse(await readFile(new URL("../../../test/fixtures/success/schema.json", import.meta.url), "utf8")),
);
const sources = {
  used: 'import {sql} from "@typed-sql/postgres"; export const used=(id:bigint)=>sql`SELECT CAST(${id} AS bigint) AS retained`;',
  unused: 'import {sql} from "@typed-sql/postgres"; export const unused=()=>sql`SELECT 1 AS unused_static`;',
  conditional:
    'import {sql} from "@typed-sql/postgres"; export const conditional=(flag:boolean)=>sql`SELECT id${flag?sql.fragment`, name AS unused_conditional`:sql.empty} FROM users`;',
  repeated:
    'import {sql} from "@typed-sql/postgres"; export const repeated=(ids:readonly number[])=>sql`SELECT id AS unused_repeated FROM users WHERE id IN (${ids.map(id=>sql.fragment`${id}`)})`;',
};

await describe("template metadata tree shaking", async () => {
  await it("removes unused direct, conditional and repeated plans through a barrel and preserves application effects", async () => {
    const modules = new Map<string, string>();
    for (const [name, source] of Object.entries(sources)) {
      const result = compileSource({ source, dialect, schema, runtimeMetadata: true });
      strict.deepEqual(result.diagnostics, []);
      modules.set(`${name}.ts`, result.transformedSource);
    }
    modules.set(
      "barrel.ts",
      Object.keys(sources)
        .map((name) => `export {${name}} from "./${name}.ts";`)
        .join("\n"),
    );
    const bundle = async () =>
      (
        await build({
          stdin: { contents: 'export {used} from "./barrel.ts";', loader: "ts" },
          bundle: true,
          write: false,
          format: "esm",
          platform: "node",
          minify: true,
          treeShaking: true,
          plugins: [
            {
              name: "compiled-templates",
              setup(bundler) {
                bundler.onResolve({ filter: /^\.\// }, (args) => ({ path: args.path.slice(2), namespace: "template" }));
                bundler.onLoad({ filter: /.*/, namespace: "template" }, (args) => ({
                  contents: modules.get(args.path)!,
                  loader: "ts",
                }));
                bundler.onResolve({ filter: /^@typed-sql\// }, (args) => ({
                  path: import.meta.resolve(args.path),
                  external: true,
                }));
              },
            },
          ],
        })
      ).outputFiles[0]!.text;
    const code = await bundle();
    strict.doesNotMatch(code, /unused_static|unused_conditional|unused_repeated/u);
    const imported = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const { getQueryValuePlan, renderQuery } = await import(import.meta.resolve("@typed-sql/core"));
    const query = imported.used(42n);
    strict.deepEqual(renderQuery(query, postgresRenderer).values, [42n]);
    strict.equal(getQueryValuePlan(query).columns[0].type, "bigint");
    modules.set("unused.ts", `${modules.get("unused.ts")}\nthrow new Error("observable application initialization");`);
    const effectful = await bundle();
    await strict.rejects(
      import(`data:text/javascript;base64,${Buffer.from(effectful).toString("base64")}`),
      /observable application initialization/u,
    );
  });
  await it("rejects invalid descriptors before constructor calls become removable", () => {
    const invalid = {
      ...dialect,
      analyze(...args: Parameters<typeof dialect.analyze>) {
        const result = dialect.analyze(...args);
        return {
          ...result,
          columns: result.columns.map((column) => ({ ...column, runtimeType: "invalid-runtime-type" as never })),
        };
      },
    };
    for (const source of Object.values(sources))
      strict.throws(() => compileSource({ source, dialect: invalid, schema, runtimeMetadata: true }), /runtime|type/iu);
  });
});
