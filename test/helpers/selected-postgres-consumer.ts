import { strict } from "node:assert";
import { execFile as callback } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);
/** Every declared PostgreSQL major loads with unrelated native profiles and eager compatibility modules absent. */
export async function assertSelectedPostgresConsumer(consumer: string, workspace: string, env: NodeJS.ProcessEnv) {
  const ledger = JSON.parse(await readFile(join(workspace, "grammar/features/ledger.json"), "utf8")),
    majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(
      ({ minimum, maximum }: { minimum: string; maximum: string }) => {
        if (minimum !== maximum) throw Error("Selected native profiles require exact PostgreSQL majors");
        return Number(minimum);
      },
    );
  const {
    build,
  }: {
    build(options: Readonly<Record<string, unknown>>): Promise<{
      readonly metafile: { readonly inputs: Readonly<Record<string, unknown>> };
      readonly outputFiles: readonly { readonly contents: Uint8Array }[];
    }>;
  } = createRequire(join(workspace, "packages/build/package.json"))("esbuild");
  const compilerManifest = createRequire(join(consumer, "package.json")).resolve("typescript/package.json");
  const compiler = JSON.parse(await readFile(compilerManifest, "utf8"));
  for (const major of majors) {
    const directory = join(consumer, "selected-profiles", String(major)),
      target = join(directory, "node_modules/@typed-sql/postgres");
    await mkdir(join(directory, "node_modules/@typed-sql"), { recursive: true });
    await cp(join(consumer, "node_modules/@typed-sql/postgres"), target, { recursive: true, dereference: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const source = join(target, "dist/packages/postgres/src");
    for (const name of [
      "analysis",
      "resolver",
      "semantics",
      "provider",
      "pg",
      "pg-contracts",
      "reconciliation",
      "catalog/native",
      "catalog/generated/native",
    ])
      for (const extension of [".js", ".d.ts", ".js.map", ".d.ts.map"])
        await rm(join(source, name + extension), { force: true });
    for (const entry of await readdir(join(source, "analysis/generated")))
      if (entry.split(".")[0] !== String(major)) await rm(join(source, "analysis/generated", entry));
    const native = join(source, "catalog/generated/native");
    for (const entry of await readdir(native, { withFileTypes: true }))
      if (entry.isFile() && entry.name.split(".")[0] !== String(major)) await rm(join(native, entry.name));
    for (const entry of await readdir(join(native, "groups")))
      if (!entry.split(".")[0]!.split("-").includes(String(major))) await rm(join(native, "groups", entry));
    const bundled = await build({
      stdin: {
        contents: `export {postgres} from "@typed-sql/postgres/analysis/profiles/${major}";`,
        resolveDir: directory,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "es2022",
      minify: true,
      metafile: true,
    });
    for (const file of Object.keys(bundled.metafile!.inputs)) {
      const nativeProfile = /catalog\/generated\/native\/(\d+)\.[cm]?js$/u.exec(file);
      if (nativeProfile) strict.equal(Number(nativeProfile[1]), major);
      const group = /catalog\/generated\/native\/groups\/([\d-]+)\.[cm]?js$/u.exec(file);
      if (group) strict.ok(group[1]!.split("-").includes(String(major)), file);
      strict.ok(!/catalog\/generated\/native\.js$/u.test(file), file);
    }
    await writeFile(join(directory, "bundle.mjs"), bundled.outputFiles![0]!.contents);
    await writeFile(
      join(directory, "check.mjs"),
      `
import assert from "node:assert/strict";
import {loadPostgresAnalyzer} from "@typed-sql/postgres/analysis/selected";
import {postgres} from "@typed-sql/postgres/analysis/profiles/${major}";
import {postgres as bundledPostgres} from "./bundle.mjs";
import {sql} from "@typed-sql/postgres";
await assert.rejects(import("@typed-sql/postgres/analysis"),{code:"ERR_MODULE_NOT_FOUND"});
const dialect=await loadPostgresAnalyzer({major:${major},versionPolicy:"canary"});
const schema={formatVersion:1,dialect:"postgres",version:${JSON.stringify(String(major))},tables:{}};
const text="SELECT lpad($2, $1, $3) AS value";
const result=dialect.analyze(text,schema);
assert.deepEqual(postgres({versionPolicy:"canary"}).analyze(text,schema),result);
assert.deepEqual(bundledPostgres({versionPolicy:"canary"}).analyze(text,schema),result);
assert.deepEqual(result.diagnostics,[]);
assert.equal(result.columns[0].tsType,"string");
assert.equal(result.columns[0].nullable,true);
assert.equal(result.columns[0].databaseType,"text");
assert.equal(text.slice(result.columns[0].range.start,result.columns[0].range.end),"lpad($2, $1, $3) AS value");
assert.deepEqual(result.parameters.map(({index,databaseType})=>({index,databaseType})),[{index:1,databaseType:"integer"},{index:2,databaseType:"text"},{index:3,databaseType:"text"}]);
assert.ok(sql\`SELECT 1\`);
const wrong=dialect.analyze(text,{...schema,version:"unknown"});
assert.equal(wrong.diagnostics[0].code,"TSQ402");assert.deepEqual(wrong.columns,[]);
`,
    );
    await execFile(process.execPath, [join(directory, "check.mjs")], { cwd: directory, env });
    // The same public declaration graph must work without the removed eager barrel's .d.ts files.
    if (major === majors[0]) {
      const types = join(directory, "consumer.mts");
      await writeFile(
        types,
        `import {loadPostgresAnalyzer} from "@typed-sql/postgres/analysis/selected";
import {postgres} from "@typed-sql/postgres/analysis/profiles/${major}";const dialect=await loadPostgresAnalyzer({major:${major}});void dialect.analyze("SELECT 1",{formatVersion:1,dialect:"postgres",version:"${major}",tables:{}});`,
      );
      await execFile(
        process.execPath,
        [
          join(dirname(compilerManifest), compiler.bin.tsc),
          "--strict",
          "--noEmit",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2024",
          "--lib",
          "ES2024,DOM,ESNext.Disposable",
          types,
        ],
        { cwd: directory, env, timeout: 60_000 },
      );
    }
  }
  await rm(join(consumer, "selected-profiles"), { recursive: true, force: true });
}
