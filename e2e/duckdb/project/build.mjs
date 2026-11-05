import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { typedSql } from "@typed-sql/build/esbuild";
import { build } from "esbuild";
import config from "./typed-sql.config.mjs";

assert.equal(config.verification.live.dialect, "duckdb");
assert.equal(config.plans.live.parameterMode, "samples-required");
assert.equal(config.verification.live.then, undefined);
const output = await build({
  entryPoints: ["entry.ts"],
  outfile: "dist/output.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  sourcemap: true,
  metafile: true,
  plugins: [typedSql()],
});
assert.ok(Object.keys(output.metafile.inputs).some((name) => name.endsWith("inline.ts")));
assert.ok(Object.keys(output.metafile.inputs).some((name) => name.endsWith("find.sql")));
await writeFile("build-metafile.json", JSON.stringify(output.metafile, null, 2));
await Promise.all([config.verification.live.close(), config.plans.live.close()]);
await assert.rejects(access("native-imports.log"), (error) => error.code === "ENOENT");
console.log("offline packed esbuild compiled inline and SQL assets without importing a native SDK");
