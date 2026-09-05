import assert from "node:assert/strict";
import test from "node:test";
import { compiledConsumerEntries, parseToolReport, sourceEntries } from "./inputs.mjs";

test("entry mapping retains public subpaths, conditions and executable entrypoints", () => {
  assert.ok(compiledConsumerEntries["packages/mysql"].includes("src/decoding.ts"));
  for (const grammar of ["mysql", "postgres", "sqlite"])
    assert.ok(compiledConsumerEntries[`packages/${grammar}`].includes("src/parser/index.ts"));
  assert.deepEqual(
    sourceEntries({
      name: "example",
      exports: {
        ".": { import: "./dist/packages/example/src/index.js" },
        "./runtime": "./dist/packages/example/src/runtime.js",
      },
      bin: { cli: "./dist/packages/example/src/cli.js" },
    }),
    ["src/cli.ts", "src/index.ts", "src/runtime.ts"],
  );
  assert.deepEqual(sourceEntries({ main: "./bundle/extension.cjs" }), ["src/extension.ts"]);
  assert.throws(() => sourceEntries({ name: "unmapped" }), /No source entrypoints/);
});

test("report parsing distinguishes findings from failure and empty scans", () => {
  assert.deepEqual(parseToolReport("knip", { status: 0, stdout: '{"issues":[]}' }), { issues: [] });
  assert.deepEqual(parseToolReport("knip", { status: 1, stdout: '{"issues":[{"file":"a.ts"}]}' }).issues, [
    { file: "a.ts" },
  ]);
  assert.throws(() => parseToolReport("knip", { status: 1, stdout: '{"issues":[]}' }), /without usable/);
  for (const result of [
    { status: 2, stdout: "{}" },
    { status: null, stdout: "{}" },
    { status: 0, stdout: "invalid" },
    { status: 0, stdout: "{}" },
    { error: new Error("spawn failed") },
  ])
    assert.throws(() => parseToolReport("knip", result));
  assert.throws(
    () => parseToolReport("biome", { status: 0, stdout: '{"summary":{"changed":0,"unchanged":0},"diagnostics":[]}' }),
    /no files/,
  );
  assert.equal(
    parseToolReport("biome", { status: 0, stdout: '{"summary":{"changed":0,"unchanged":2},"diagnostics":[]}' }).summary
      .unchanged,
    2,
  );
});
