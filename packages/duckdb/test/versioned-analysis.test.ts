import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { recognitionQueries } from "../../../scripts/language-audit/queries.js";
import { duckdb } from "../src/browser.js";
import { combineDuckDBCatalogs, createDuckDBCatalog, extendDuckDBCatalog } from "../src/catalog/provider.js";
import type { DuckDBBuiltinSignature } from "../src/catalog/types.js";
import { DUCKDB_SUPPORT_POLICY } from "../src/support-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const esbuild = createRequire(new URL("../../build/package.json", import.meta.url))("esbuild");

await describe("version-isolated offline DuckDB analysis", async () => {
  for (const version of DUCKDB_SUPPORT_POLICY.qualifiedEngines) {
    await it(`${version} matches compatibility outcomes for independently captured invocation candidates`, async () => {
      const module = (await import(`../src/analysis/${version}.js`)) as { duckdb: typeof duckdb };
      const selected = module.duckdb();
      const snapshot = selected.validateSnapshot({
        formatVersion: 1,
        dialect: "duckdb",
        server: fixtureEvidence(version),
        tables: {},
      });
      const inventory = JSON.parse(
        await readFile(
          new URL(`../../../test/fixtures/language-audit/duckdb-${version}.json`, import.meta.url),
          "utf8",
        ),
      );
      const compatibility = duckdb();
      const queries = new Set<string>(inventory.categories.functions.rows.flatMap(recognitionQueries));
      for (const source of queries)
        strict.deepEqual(selected.analyze(source, snapshot), compatibility.analyze(source, snapshot), source);
      for (const source of [
        "SELECT CAST(1 AS BIGINT)+CAST(1.5 AS DOUBLE) AS value",
        "SELECT CAST(NULL AS DATE) AS value UNION ALL SELECT CAST(NULL AS TIMESTAMP)",
        "SELECT list_value(CAST(1 AS SMALLINT),CAST(2 AS BIGINT)) AS value",
        "WITH items AS (SELECT 1 AS id) SELECT id FROM items WHERE id=$1",
      ])
        strict.deepEqual(selected.analyze(source, snapshot), compatibility.analyze(source, snapshot), source);
      strict.ok(queries.size > 0);
      const other = DUCKDB_SUPPORT_POLICY.qualifiedEngines.find((value) => value !== version)!;
      const wrong = { ...snapshot, server: fixtureEvidence(other) };
      strict.throws(() => selected.validateSnapshot(wrong), /selected DuckDB analyzer requires engine/);
      const refused = selected.analyze("SELECT 1 AS value", wrong);
      strict.equal(refused.diagnostics[0]?.code, "TSQ402");
      strict.deepEqual(refused.columns, []);
    });
    await it(`${version} excludes the other engine's metadata from its analyzer graph`, async () => {
      const bundle = (source: string) =>
        esbuild.build({
          stdin: {
            contents: `export {duckdb} from ${JSON.stringify(source)}`,
            resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
            loader: "ts",
          },
          bundle: true,
          platform: "node",
          format: "esm",
          minify: true,
          write: false,
          metafile: true,
        });
      const selected = await bundle(fileURLToPath(new URL(`../src/analysis/${version}.ts`, import.meta.url)));
      const compatibility = await bundle(fileURLToPath(new URL("../src/analysis.ts", import.meta.url)));
      const inputs = Object.keys(selected.metafile.inputs);
      const other = DUCKDB_SUPPORT_POLICY.qualifiedEngines.find((value) => value !== version)!;
      strict.ok(inputs.some((path) => path.endsWith(`/catalog/${version}.ts`)));
      strict.ok(
        !inputs.some((path) => path.endsWith(`/catalog/${other}.ts`) || path.endsWith(`/catalog/common-${other}.ts`)),
      );
      strict.ok(!inputs.some((path) => path.endsWith("/catalog/index.ts") || path.endsWith("/browser.ts")));
      strict.ok(selected.outputFiles[0].contents.byteLength < compatibility.outputFiles[0].contents.byteLength);
    });
  }
  await it("owns immutable engine facts and rejects duplicate version ownership", () => {
    const parameters = ["INTEGER"];
    const signatures: DuckDBBuiltinSignature[] = [
      ["sample", "scalar", parameters, "INTEGER", null, "CONSISTENT", false],
    ];
    const implicitCasts: [string, string][] = [["INTEGER", "BIGINT"]];
    const commonTypes = { "INTEGER|BIGINT": "BIGINT" };
    const expressionTypes = { "INTEGER|BIGINT": "BIGINT" };
    const owner = createDuckDBCatalog({ version: "1.5.6", signatures, implicitCasts, commonTypes, expressionTypes });
    parameters[0] = "DOUBLE";
    signatures.length = 0;
    implicitCasts.length = 0;
    commonTypes["INTEGER|BIGINT"] = "DOUBLE";
    expressionTypes["INTEGER|BIGINT"] = "DOUBLE";
    strict.deepEqual(owner.signatures("1.5.6", "sample")[0]?.[2], ["INTEGER"]);
    strict.equal(owner.implicitCast("1.5.6", "INTEGER", "BIGINT"), true);
    strict.equal(owner.combinations("1.5.6", "set")["INTEGER|BIGINT"], "BIGINT");
    strict.equal(owner.combinations("1.5.6", "expression")["INTEGER|BIGINT"], "BIGINT");
    strict.ok(Object.isFrozen(owner.catalog("1.5.6")));
    strict.ok(Object.isFrozen(owner.signatures("1.5.6", "sample")[0]?.[2]));
    strict.deepEqual(owner.catalog("future"), []);
    strict.deepEqual(owner.signatures("future", "sample"), []);
    strict.deepEqual(owner.combinations("future", "set"), {});
    strict.equal(owner.implicitCast("future", "INTEGER", "BIGINT"), false);
    strict.equal(owner.hasBuiltin("1.5.6", "sample"), true);
    strict.equal(owner.hasBuiltin("future", "sample"), false);
    strict.equal(owner.permitsBuiltin("1.5.6", "sample"), true);
    strict.equal(owner.permitsBuiltin("future", "sample"), false);
    const combined = combineDuckDBCatalogs([owner]);
    strict.equal(combined.combinations("1.5.6", "set")["INTEGER|BIGINT"], "BIGINT");
    strict.deepEqual(combined.catalog("future"), []);
    strict.deepEqual(combined.signatures("future", "sample"), []);
    strict.deepEqual(combined.combinations("future", "expression"), {});
    strict.equal(combined.hasBuiltin("future", "sample"), false);
    strict.equal(combined.hasBuiltin("1.5.6", "sample"), true);
    strict.equal(combined.permitsBuiltin("future", "sample"), false);
    strict.equal(combined.permitsBuiltin("1.5.6", "sample"), true);
    strict.throws(() => combineDuckDBCatalogs([owner, owner]), /Duplicate DuckDB catalog/);
    const permitted = ["sample"];
    const known = ["sample", "omitted"];
    const restricted = createDuckDBCatalog({
      version: "1.5.6",
      signatures: owner.catalog("1.5.6"),
      implicitCasts: [["INTEGER", "BIGINT"]],
      commonTypes,
      expressionTypes,
      knownBuiltinNames: known,
      selection: permitted,
    });
    permitted.push("omitted");
    known.push("untrusted");
    strict.equal(restricted.hasBuiltin("1.5.6", "omitted"), true);
    strict.equal(restricted.hasBuiltin("1.5.6", "untrusted"), false);
    strict.equal(restricted.permitsBuiltin("1.5.6", "omitted"), false);
    const additional = createDuckDBCatalog({
      version: "1.5.6",
      signatures: [["omitted", "scalar", [], "INTEGER", null, "CONSISTENT", false]],
      implicitCasts: [],
      commonTypes: {},
      expressionTypes: {},
    });
    const extended = extendDuckDBCatalog(restricted, additional, "1.5.6");
    strict.equal(extended.catalog("1.5.6").length, 2);
    strict.equal(extended.catalog("1.5.6"), extended.catalog("1.5.6"));
    strict.deepEqual(extended.catalog("future"), []);
    strict.equal(extended.signatures("1.5.6", "sample").length, 1);
    strict.equal(extended.signatures("1.5.6", "omitted").length, 1);
    strict.equal(extended.signatures("future", "omitted").length, 0);
    strict.equal(extended.hasBuiltin("1.5.6", "sample"), true);
    strict.equal(extended.hasBuiltin("future", "sample"), false);
    strict.equal(extended.permitsBuiltin("1.5.6", "omitted"), true);
    strict.equal(extended.permitsBuiltin("future", "sample"), false);
    strict.equal(extended.implicitCast("1.5.6", "INTEGER", "BIGINT"), true);
    strict.equal(extended.combinations("1.5.6", "set")["INTEGER|BIGINT"], commonTypes["INTEGER|BIGINT"]);
    strict.throws(() => extendDuckDBCatalog(owner, owner, "1.5.6"), /Overlapping DuckDB offline family/u);
  });
});
