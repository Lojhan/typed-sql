import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strict as assert, describe, it } from "poku";
import { command, consumer, writeEntry } from "../src/consumer.mjs";

const fixture = await consumer([
  "esbuild",
  "vite",
  "vite-legacy",
  "rollup",
  "rolldown",
  "webpack",
  "@rspack/core",
  "@rsbuild/core",
]);
try {
  await describe("Packed native bundler integrations", async () => {
    for (const host of [
      "esbuild",
      "vite",
      "vite-legacy",
      "rollup",
      "rolldown",
      "webpack",
      "@rspack/core",
      "@rsbuild/core",
    ]) {
      await it(`${host} compiles SQL modules and inline query plans and executes real SQLite queries`, async () => {
        const root = await fixture.project(host.replaceAll("/", "-"));
        await writeEntry(root);
        const plugin =
          host === "vite-legacy"
            ? "vite"
            : host === "@rspack/core"
              ? "rspack"
              : host === "@rsbuild/core"
                ? "rsbuild"
                : host;
        const build = {
          esbuild: `await tool.build({absWorkingDir: root,entryPoints:["entry.ts"],outfile:"dist/output.mjs",bundle:true,platform:"node",format:"esm",packages:"external",plugins:[typedSql({cwd:root})],sourcemap:true});`,
          vite: `await tool.build({root,configFile:false,plugins:[typedSql({cwd:root})],build:{ssr:"entry.ts",outDir:"dist",sourcemap:true,rollupOptions:{output:{entryFileNames:"output.mjs"}}}});`,
          "vite-legacy": `await tool.build({root,configFile:false,plugins:[typedSql({cwd:root})],build:{ssr:"entry.ts",outDir:"dist",sourcemap:true,rollupOptions:{output:{entryFileNames:"output.mjs"}}}});`,
          rollup: `const bundle=await tool.rollup({input:root+"/entry.ts",plugins:[typedSql({cwd:root})],external:id=>id.startsWith("@typed-sql/")}); try {await bundle.write({file:root+"/dist/output.mjs",format:"esm",sourcemap:true});} finally {await bundle.close();}`,
          rolldown: `const bundle=await tool.rolldown({input:root+"/entry.ts",plugins:[typedSql({cwd:root})],external:id=>id.startsWith("@typed-sql/")}); try {await bundle.write({file:root+"/dist/output.mjs",format:"esm",sourcemap:true});} finally {await bundle.close();}`,
          webpack: `await new Promise((resolve,reject)=>{const compiler=tool.default({mode:"development",context:root,target:"node",entry:"./entry.ts",devtool:"source-map",experiments:{outputModule:true},externalsType:"module",externals:[({request},callback)=>request?.startsWith("@typed-sql/")?callback(null,request):callback()],output:{path:root+"/dist",filename:"output.mjs",library:{type:"module"}},plugins:[typedSql({cwd:root})]});compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?reject(error??closeError??new Error(stats.toString())):resolve()));});`,
          "@rspack/core": `await new Promise((resolve,reject)=>{const compiler=tool.rspack({mode:"development",context:root,target:"node",entry:"./entry.ts",devtool:"source-map",experiments:{outputModule:true},externalsType:"module",externals:[({request},callback)=>request?.startsWith("@typed-sql/")?callback(null,request):callback()],output:{path:root+"/dist",filename:"output.mjs",library:{type:"module"}},plugins:[typedSql({cwd:root})]});compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?reject(error??closeError??new Error(stats.toString())):resolve()));});`,
          "@rsbuild/core": `const instance=await tool.createRsbuild({cwd:root,rsbuildConfig:{plugins:[typedSql({cwd:root})],environments:{server:{source:{entry:{output:"./entry.ts"}},output:{target:"node",distPath:{root:"dist"},filename:{js:"output.mjs"}},tools:{rspack:{externalsType:"module",externals:[({request},callback)=>request?.startsWith("@typed-sql/")?callback(null,request):callback()],experiments:{outputModule:true},output:{library:{type:"module"}}}}}}}});await instance.build();`,
        }[host];
        const result = await fixture.node(
          root,
          `import * as tool from ${JSON.stringify(host)};\nimport {typedSql} from "@typed-sql/build/${plugin}";\nconst root=process.cwd();\n${build}\nimport {verify} from "./verify.mjs";\nawait verify(await import("./dist/output.mjs"));\nconsole.log("executed compiled queries");`,
        );
        assert.match(result.output, /executed compiled queries/u);
        await writeFile(
          join(root, "entry.ts"),
          'import query from "./query.sql"; export {query}; export const value: number = 1;',
        );
        const fileOnly = await fixture.node(
          root,
          `import * as tool from ${JSON.stringify(host)};\nimport {typedSql} from "@typed-sql/build/${plugin}";\nconst root=process.cwd();\n${build.replaceAll("typedSql({cwd:root})", "typedSql({cwd:root,inline:false})")}\nimport {verify} from "./verify.mjs";\nawait verify(await import("./dist/output.mjs"));\nconsole.log("SQL-only mode executes");`,
          "file-only.mjs",
        );
        assert.match(fileOnly.output, /SQL-only mode executes/u);
        // The same real host must reject unsupported SQL instead of emitting optimistic plans.
        await writeFile(join(root, "query.sql"), "SELECT nonexistent FROM account");
        await writeFile(
          join(root, "invalid.mjs"),
          `import * as tool from ${JSON.stringify(host)};\nimport {typedSql} from "@typed-sql/build/${plugin}";\nconst root=process.cwd();\n${build}`,
        );
        const invalid = await command(root, process.execPath, ["invalid.mjs"], { allowFailure: true });
        assert.notEqual(invalid.code, 0);
        assert.match(invalid.output, /TSQ101.*Unknown column nonexistent/u);
      });
    }
  });
} finally {
  await fixture.close();
}
