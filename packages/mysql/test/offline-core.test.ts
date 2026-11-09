import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStaticQueryClaim } from "@typed-sql/analysis";
import { unknownQuerySemantics } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { recognitionQueries } from "../../../scripts/language-audit/queries.js";
import { MYSQL_SUPPORT_POLICY, mySqlCoreCatalog, mysql } from "../src/analysis.js";
import { mySqlServerEvidence } from "../src/capabilities.js";
import { createMySqlCatalogProvider } from "../src/catalog/provider.js";
import { mySqlContractIdentity } from "../src/contract-profile.js";
import type { MySqlCoreOptions, MySqlOfflinePack } from "../src/offline-packs.js";
import { createMySqlContractReconciler } from "../src/reconciliation.js";

type Factory = (options?: MySqlCoreOptions) => ReturnType<typeof mysql>;
const targets = [
  ...MYSQL_SUPPORT_POLICY.stable.map((target) => ({ ...target, canary: false })),
  { ...MYSQL_SUPPORT_POLICY.canary, canary: true },
];
const esbuild = createRequire(new URL("../../build/package.json", import.meta.url))("esbuild");
await describe("MySQL selected-series core and installed compatibility packs", async () => {
  await it("regenerates every partition and runtime projection from maintained policy", () => {
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../../../scripts/generate-mysql-catalog.mjs", import.meta.url)), "--check"],
      { stdio: "pipe" },
    );
  });
  for (const target of targets) {
    const { series, matrixVersion } = target;
    const options = target.canary ? { versionPolicy: "canary" as const } : {};
    const { mysql: createCore } = (await import(`../src/analysis/core/${series}.js`)) as { mysql: Factory };
    const { mysql: createSelected } = (await import(`../src/analysis/${series}.js`)) as { mysql: Factory };
    const { mysqlCompatibilityPack: pack } = (await import(`../src/analysis/packs/${series}/compatibility.js`)) as {
      mysqlCompatibilityPack: MySqlOfflinePack;
    };
    const { selection, prefixes } = (await import(`../src/catalog/generated/core/${series}.js`)) as {
      selection: readonly string[];
      prefixes: readonly string[];
    };
    const core = createCore(options),
      full = mysql(options),
      selected = createSelected(options),
      expanded = createCore({ ...options, packs: [pack] });
    const schema = core.validateSnapshot({
      formatVersion: 1,
      dialect: "mysql",
      server: mySqlServerEvidence(matrixVersion),
      tables: {},
    });
    await it(`${series} preserves selected outcomes and restores the full independently captured invocation inventory`, async () => {
      const inventory = JSON.parse(
        await readFile(new URL(`../../../test/fixtures/language-audit/mysql-${series}.json`, import.meta.url), "utf8"),
      );
      let all = 0,
        included = 0;
      for (const row of inventory.categories.functions.rows)
        for (const sql of recognitionQueries(row)) {
          const expected = full.analyze(sql, schema);
          strict.deepEqual(selected.analyze(sql, schema), expected, sql);
          strict.deepEqual(expanded.analyze(sql, schema), expected, sql);
          all++;
          const name = row.name.toUpperCase();
          if (selection.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
            strict.deepEqual(core.analyze(sql, schema), expected, sql);
            included++;
          }
        }
      strict.ok(included > 0 && included < all);
      for (const sql of [
        "SELECT UPPER(CAST(? AS CHAR)) AS label, CAST(? AS SIGNED) AS id",
        "SELECT JSON_SET('{}','$.value',CAST(? AS SIGNED)) AS value",
        "SELECT ROUND(1.25,1) AS value UNION ALL SELECT 2.5",
        "WITH items AS (SELECT 1 AS id) SELECT id FROM items WHERE id>?",
      ]) {
        strict.deepEqual(core.analyze(sql, schema), full.analyze(sql, schema), sql);
      }
      strict.deepEqual(core.analyze("SELECT UPPER(CAST(? AS CHAR)) AS label", schema).diagnostics, []);
    });
    await it(`${series} preserves unavailable-version and SQL-mode guards while diagnosing omitted rules`, () => {
      const sql = "SELECT SQRT(CAST(? AS DECIMAL(12,3))) AS value";
      strict.deepEqual(full.analyze(sql, schema).diagnostics, []);
      const result = core.analyze(sql, schema);
      strict.equal(result.diagnostics[0]?.code, "TSQ408");
      strict.match(result.diagnostics[0]!.message, /compatibility pack or generate a qualified query contract/u);
      strict.deepEqual(result.parameters, full.analyze(sql, schema).parameters);
      strict.ok(result.columns.every((column) => column.tsType === "unknown"));
      strict.deepEqual(expanded.analyze(sql, schema), full.analyze(sql, schema));
      const unavailable = core.analyze("SELECT VECTOR_DIM(?) AS value", schema);
      strict.equal(
        unavailable.diagnostics[0]?.code,
        series === MYSQL_SUPPORT_POLICY.stable[0].series ? "TSQ403" : "TSQ408",
      );
      const modes = { ...schema, server: mySqlServerEvidence(matrixVersion, { sqlMode: "HIGH_NOT_PRECEDENCE" }) };
      strict.deepEqual(core.analyze("SELECT 1 AS value", modes), full.analyze("SELECT 1 AS value", modes));
      strict.equal(core.analyze("SELECT 1 AS value", modes).diagnostics[0]?.code, "TSQ407");
      const edition = {
        ...schema,
        server: { ...schema.server!, settings: { ...schema.server!.settings, edition: "unqualified" } },
      };
      strict.throws(() => core.analyze("SELECT UPPER('x') AS value", edition), /edition evidence is invalid/u);
      strict.throws(() => full.analyze("SELECT UPPER('x') AS value", edition), /edition evidence is invalid/u);
      if (target.canary) {
        const conservative = createCore().analyze("SELECT 1 AS value", schema);
        strict.deepEqual(conservative, mysql().analyze("SELECT 1 AS value", schema));
        const states = createCore().resolveCapabilities!(schema);
        strict.ok(Object.values(states).some((state) => state.reason.includes("not in the tested")));
        strict.ok(
          Object.values(states).every((state) =>
            state.evidence.some(
              (item) => item.kind === "policy" && item.key === "versionChannel" && item.value === "stable",
            ),
          ),
        );
      }
    });
    await it(`${series} refuses wrong-series snapshots, forged packs and duplicate packs`, async () => {
      const other = targets.find((value) => value.series !== series)!;
      const { mysqlCompatibilityPack: otherPack } = await import(
        `../src/analysis/packs/${other.series}/compatibility.js`
      );
      strict.throws(() => createCore({ ...options, packs: [otherPack] }), /offline pack requires series/u);
      strict.throws(
        () => core.validateSnapshot({ ...schema, server: mySqlServerEvidence(other.matrixVersion) }),
        /selected MySQL analyzer requires series/u,
      );
      strict.throws(
        () => selected.validateSnapshot({ ...schema, version: undefined, server: undefined }),
        /selected MySQL analyzer requires series/u,
      );
      strict.equal(
        core.analyze("SELECT 1 AS value", { ...schema, server: mySqlServerEvidence(other.matrixVersion) })
          .diagnostics[0]?.code,
        "TSQ402",
      );
      strict.throws(() => createCore({ ...options, packs: [{ ...pack }] }), /installed grammar pack export/u);
      strict.throws(() => createCore({ ...options, packs: [pack, pack] }), /Duplicate MySQL offline pack/u);
      strict.equal(pack.sourceRevision, mySqlCoreCatalog(series)?.revision);
      strict.ok(Object.isFrozen(pack));
    });
    await it(`${series} excludes other full catalogs and the optional routine partition from its core graph`, async () => {
      const path = (part: string) => JSON.stringify(fileURLToPath(new URL(`../src/${part}.ts`, import.meta.url)));
      const build = (entry: string) =>
        esbuild.build({
          stdin: {
            contents: `export {mysql} from ${path(entry)}`,
            loader: "ts",
            resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
          },
          bundle: true,
          platform: "node",
          format: "esm",
          minify: true,
          write: false,
          metafile: true,
        });
      const built = await build(`analysis/core/${series}`),
        compat = await build("analysis");
      const inputs = Object.keys(built.metafile.inputs);
      strict.ok(inputs.some((input) => input.endsWith(`/catalog/generated/core/${series}.ts`)));
      for (const other of targets)
        strict.ok(
          !inputs.some(
            (input) =>
              input.endsWith(`/catalog/generated/${other.series}.ts`) ||
              input.includes("/catalog/generated/packs/") ||
              (other.series !== series && input.endsWith(`/catalog/generated/core/${other.series}.ts`)),
          ),
        );
      strict.ok(
        !inputs.some(
          (input) =>
            input.endsWith("/catalog/index.ts") ||
            input.endsWith("/compatibility-resolver.ts") ||
            input.endsWith("/mysql/src/provider.ts") ||
            input.includes("mysql2"),
        ),
      );
      strict.ok(built.outputFiles[0].contents.byteLength < compat.outputFiles[0].contents.byteLength);
    });
  }
  await it("classifies only the specific omitted-rule diagnostic as eligible for native evidence", () => {
    const owner = createMySqlContractReconciler();
    const range = { start: 0, end: 1, line: 1, column: 1 };
    const claim = createStaticQueryClaim({
      sql: "SELECT 1",
      context: {
        grammar: owner.grammar,
        ...mySqlContractIdentity(),
        schemaHash: "0".repeat(64),
        databaseContextHash: "0".repeat(64),
        typePolicyHash: "0".repeat(64),
      },
      analysis: {
        semantics: unknownQuerySemantics(range, "Omitted fixture rule"),
        columns: [],
        parameters: [],
        diagnostics: [{ code: "TSQ408", severity: "error", message: "omitted", range }],
      },
    });
    strict.equal(owner.classify(claim).status, "unsupported");
    strict.equal(
      owner.classify({
        ...claim,
        diagnostics: [...claim.diagnostics, { code: "TSQ403", severity: "error" }],
      }).status,
      "invalid",
    );
  });
  await it("owns catalog, selection and availability inputs without exposing mutable backing data", () => {
    const source = structuredClone(mySqlCoreCatalog(MYSQL_SUPPORT_POLICY.stable[0].series)!);
    const selection = ["COUNT"],
      availability = { COUNT: [source.series] };
    const provider = createMySqlCatalogProvider([source], { selection, routineSeries: availability });
    selection.push("SQRT");
    availability.COUNT.length = 0;
    strict.equal(provider.permitsBuiltin("sqrt"), false);
    strict.equal(
      provider.isRoutineAvailable("COUNT", {
        formatVersion: 1,
        dialect: "mysql",
        version: MYSQL_SUPPORT_POLICY.stable[0].matrixVersion,
        tables: {},
      }),
      true,
    );
    strict.ok(Object.isFrozen(provider.catalog(source.series)?.routines));
    strict.throws(() => createMySqlCatalogProvider([source, source]), /Duplicate MySQL catalog/u);
  });
});
