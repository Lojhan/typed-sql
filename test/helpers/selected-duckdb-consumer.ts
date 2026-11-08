import { strict } from "node:assert";
import { execFile as callback } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(callback);
export async function assertSelectedDuckDBConsumer(
  consumer: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const ledger = JSON.parse(await readFile(join(workspace, "grammar/features/ledger.json"), "utf8"));
  const versions: string[] = [...ledger.dialects.duckdb.stable, ...ledger.dialects.duckdb.canary].map(
    ({ minimum, maximum }: { minimum: string; maximum: string }) => {
      strict.equal(minimum, maximum);
      return minimum;
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
  for (const version of versions) {
    const directory = join(consumer, "selected-duckdb", version),
      target = join(directory, "node_modules/@typed-sql/duckdb");
    await mkdir(dirname(target), { recursive: true });
    await cp(join(consumer, "node_modules/@typed-sql/duckdb"), target, { recursive: true, dereference: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const source = join(target, "dist/packages/duckdb/src");
    for (const name of [
      "analysis",
      "browser",
      "resolver",
      "provider",
      "provider-implementation",
      "node-api",
      "catalog/index",
      "catalog/resolution",
      "catalog/named-arguments",
      "catalog/generated/registry",
      "catalog/generated/profiles",
    ])
      for (const extension of [".js", ".d.ts", ".js.map", ".d.ts.map"])
        await rm(join(source, name + extension), { force: true });
    for (const other of versions.filter((other) => other !== version))
      for (const name of [
        `catalog/generated/${other}`,
        `catalog/generated/common-${other}`,
        `catalog/generated/profiles/${other}`,
        `analysis/generated/${other}`,
      ])
        for (const extension of [".js", ".d.ts", ".js.map", ".d.ts.map"])
          await rm(join(source, name + extension), { force: true });
    const bundled = await build({
      stdin: {
        contents: `export {duckdb} from "@typed-sql/duckdb/analysis/profiles/${version}";`,
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
    const profiles = new Set<string>();
    for (const file of Object.keys(bundled.metafile.inputs)) {
      const profile = /catalog\/generated\/(?:common-)?(\d+\.\d+\.\d+)\.js$/u.exec(file);
      if (profile) {
        strict.equal(profile[1], version);
        profiles.add(file);
      }
      strict.ok(
        !/catalog\/(?:index|resolution|named-arguments|generated\/registry|generated\/profiles)\.js$/u.test(file),
        file,
      );
    }
    strict.equal(profiles.size, 2, "The selected signature profile and common-type profile must both be present");
    await writeFile(join(directory, "bundle.mjs"), bundled.outputFiles[0]!.contents);
    const settings = {
      Calendar: "gregorian",
      integer_division: "false",
      preserve_identifier_case: version === "1.5.6" ? "true" : "preserve_case",
      ...(version === "1.5.6" ? { old_implicit_casting: "false" } : {}),
    };
    const schema = {
      formatVersion: 1,
      dialect: "duckdb",
      server: { product: "duckdb", version, versionKey: version, features: [], settings },
      tables: {},
    };
    await writeFile(
      join(directory, "check.mjs"),
      `
import assert from "node:assert/strict";
import {loadDuckDBAnalyzer} from "@typed-sql/duckdb/analysis/selected";
import {duckdb} from "@typed-sql/duckdb/analysis/profiles/${version}";
import {duckdb as bundledDuckDB} from "./bundle.mjs";
import {sql} from "@typed-sql/duckdb";
await assert.rejects(import("@typed-sql/duckdb/analysis"),{code:"ERR_MODULE_NOT_FOUND"});
const dialect=await loadDuckDBAnalyzer({version:${JSON.stringify(version)}});
const schema=${JSON.stringify(schema)};
const text="SELECT lower($1::VARCHAR) AS label, power(y := 2, x := 3) AS value";
const result=dialect.analyze(text,schema);
assert.deepEqual(result.diagnostics,[]);
assert.deepEqual(duckdb().analyze(text,schema),result);
assert.deepEqual(bundledDuckDB().analyze(text,schema),result);
assert.equal(result.columns[0].tsType,"string");assert.equal(result.columns[0].databaseType,"VARCHAR");
assert.equal(result.columns[1].tsType,"number");
assert.equal(text.slice(result.columns[0].range.start,result.columns[0].range.end),"lower($1::VARCHAR)");
assert.equal(result.parameters[0].index,1);assert.equal(result.parameters[0].databaseType,"VARCHAR");
assert.ok(sql\`SELECT 1\`);
const wrong=dialect.analyze(text,{...schema,server:{...schema.server,versionKey:"unsupported"}});
assert.equal(wrong.diagnostics[0].code,"TSQ402");assert.deepEqual(wrong.columns,[]);
`,
    );
    await execFile(process.execPath, [join(directory, "check.mjs")], { cwd: directory, env });
    if (version === versions[0]) {
      const types = join(directory, "consumer.mts");
      await writeFile(
        types,
        `import {loadDuckDBAnalyzer} from "@typed-sql/duckdb/analysis/selected";import {duckdb} from "@typed-sql/duckdb/analysis/profiles/${version}";const dialect=await loadDuckDBAnalyzer({version:"${version}"});void dialect.analyze("SELECT 1",${JSON.stringify(schema)});void duckdb();`,
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
        { cwd: directory, env, timeout: 60000 },
      );
    }
  }
  await rm(join(consumer, "selected-duckdb"), { recursive: true, force: true });
}
