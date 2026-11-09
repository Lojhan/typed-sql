import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, it, strict } from "poku";
import { recognitionQueries } from "../../../scripts/language-audit/queries.js";
import { duckdb } from "../src/browser.js";
import type { DuckDBCoreOptions, DuckDBOfflinePack } from "../src/offline-packs.js";
import { DUCKDB_SUPPORT_POLICY } from "../src/support-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const esbuild = createRequire(new URL("../../build/package.json", import.meta.url))("esbuild");
type Factory = (options?: DuckDBCoreOptions) => ReturnType<typeof duckdb>;
await describe("bounded offline DuckDB core and explicit compatibility packs", async () => {
  await it("regenerates deterministically from maintained selection and installed facts without a database", () => {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-offline-core.mjs", "--check"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "pipe",
    });
  });
  for (const version of DUCKDB_SUPPORT_POLICY.qualifiedEngines) {
    const module = (await import(`../src/analysis/core/${version}.js`)) as { duckdb: Factory };
    const { duckdbCompatibilityPack: pack } = (await import(`../src/analysis/packs/${version}/compatibility.js`)) as {
      duckdbCompatibilityPack: DuckDBOfflinePack;
    };
    const facts = (await import(`../src/catalog/core/${version}.js`)) as {
      selection: readonly string[];
      provenance: { sourceDigest: string };
    };
    const core = module.duckdb();
    const compatibility = duckdb();
    const expanded = module.duckdb({ packs: [pack] });
    const snapshot = core.validateSnapshot({
      formatVersion: 1,
      dialect: "duckdb",
      server: fixtureEvidence(version),
      tables: {},
    });
    const inventory = JSON.parse(
      await readFile(new URL(`../../../test/fixtures/language-audit/duckdb-${version}.json`, import.meta.url), "utf8"),
    );
    await it(`${version} preserves selected families and restores every compatibility invocation outcome with its pack`, () => {
      const selected = new Set(facts.selection);
      let selectedCount = 0,
        allCount = 0;
      for (const row of inventory.categories.functions.rows) {
        for (const source of recognitionQueries(row)) {
          const full = compatibility.analyze(source, snapshot);
          strict.deepEqual(expanded.analyze(source, snapshot), full, source);
          allCount++;
          // The independent inventory owns query construction, not the generated projection.
          if (selected.has(row.name)) {
            strict.deepEqual(core.analyze(source, snapshot), full, source);
            selectedCount++;
          }
        }
      }
      strict.ok(selectedCount > 0 && selectedCount < allCount);
      for (const source of [
        "SELECT CAST(1 AS BIGINT)+CAST(1.5 AS DOUBLE) AS value",
        "SELECT upper($1) AS value, CAST($2 AS INTEGER) AS other",
        "SELECT CAST(NULL AS DATE) AS value UNION ALL SELECT CAST(NULL AS TIMESTAMP)",
        "SELECT list_value(CAST(1 AS SMALLINT),CAST(2 AS BIGINT)) AS value",
        "WITH items AS (SELECT 1 AS id) SELECT id FROM items WHERE id=$1",
      ])
        strict.deepEqual(core.analyze(source, snapshot), compatibility.analyze(source, snapshot), source);
    });
    await it(`${version} diagnoses omitted handwritten and generic rules before claiming a result`, () => {
      for (const source of ["SELECT isfinite(1.0) AS value", "SELECT md5('hello') AS value"]) {
        strict.deepEqual(compatibility.analyze(source, snapshot).diagnostics, []);
        const result = core.analyze(source, snapshot);
        strict.equal(result.diagnostics[0]?.code, "TSQ408");
        strict.match(result.diagnostics[0]!.message, /compatibility pack or generate a qualified query contract/u);
        strict.ok(result.columns.every((column) => column.tsType === "unknown"));
        strict.deepEqual(expanded.analyze(source, snapshot), compatibility.analyze(source, snapshot));
      }
      const invalid = "SELECT upper(1,2) AS value";
      strict.deepEqual(core.analyze(invalid, snapshot), compatibility.analyze(invalid, snapshot));
      strict.ok(core.analyze(invalid, snapshot).diagnostics.some((item) => item.code === "TSQ201"));
    });
    await it(`${version} refuses forged, repeated and other-engine packs and retains captured provenance`, async () => {
      const otherVersion = DUCKDB_SUPPORT_POLICY.qualifiedEngines.find((value) => value !== version)!;
      const { duckdbCompatibilityPack: other } = await import(`../src/analysis/packs/${otherVersion}/compatibility.js`);
      strict.throws(() => module.duckdb({ packs: [other] }), /offline pack requires engine/u);
      strict.throws(() => module.duckdb({ packs: [pack, pack] }), /Duplicate DuckDB offline pack/u);
      strict.throws(() => module.duckdb({ packs: [{ ...pack }] }), /installed grammar pack export/u);
      strict.throws(
        () => core.validateSnapshot({ ...snapshot, server: fixtureEvidence(otherVersion) }),
        /selected DuckDB analyzer/u,
      );
      strict.ok(Object.isFrozen(pack));
      strict.equal(
        pack.sourceDigest,
        createHash("sha256")
          .update(
            JSON.stringify({
              signatures: (await import(`../src/catalog/${version}.js`)).signatures,
              casts: (await import(`../src/catalog/${version}.js`)).implicitCasts,
            }),
          )
          .digest("hex"),
      );
      strict.equal(pack.sourceDigest, facts.provenance.sourceDigest);
    });
    await it(`${version} imports no complete catalog or other engine in its core graph`, async () => {
      const bundle = (contents: string) =>
        esbuild.build({
          stdin: { contents, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "ts" },
          bundle: true,
          minify: true,
          write: false,
          metafile: true,
          platform: "node",
          format: "esm",
        });
      const path = (entry: string) => JSON.stringify(fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url)));
      const selected = await bundle(`export {duckdb} from ${path(`analysis/core/${version}`)}`);
      const full = await bundle(`export {duckdb} from ${path(`analysis/${version}`)}`);
      const inputs = Object.keys(selected.metafile.inputs);
      for (const engine of DUCKDB_SUPPORT_POLICY.qualifiedEngines)
        strict.ok(
          !inputs.some(
            (input) => input.endsWith(`/catalog/${engine}.ts`) || input.endsWith(`/catalog/engines/${engine}.ts`),
          ),
        );
      strict.ok(inputs.some((input) => input.endsWith(`/catalog/core/${version}.ts`)));
      strict.ok(!inputs.some((input) => input.endsWith("/browser.ts") || input.endsWith("/catalog/index.ts")));
      strict.ok(selected.outputFiles[0].contents.byteLength < full.outputFiles[0].contents.byteLength);
      strict.ok(!inputs.some((input) => input.includes("node-api")));
    });
  }
});
