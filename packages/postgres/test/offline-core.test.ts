import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStaticQueryClaim } from "@typed-sql/analysis";
import { unknownQuerySemantics } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { recognitionQueries } from "../../../scripts/language-audit/queries.js";
import { POSTGRES_SUPPORT_POLICY, postgres, postgresServerEvidence } from "../src/analysis.js";
import { postgresContractIdentity } from "../src/contract-profile.js";
import { createPostgresContractReconciler } from "../src/reconciliation.js";

type Factory = typeof postgres;
const esbuild = createRequire(new URL("../../build/package.json", import.meta.url))("esbuild");
const targets = [
  ...POSTGRES_SUPPORT_POLICY.stableMajors.map((major) => ({ major, version: `${major}.0`, canary: false })),
  { major: POSTGRES_SUPPORT_POLICY.canary.major, version: POSTGRES_SUPPORT_POLICY.canary.version, canary: true },
];
await describe("PostgreSQL selected-major full and core analyzers", async () => {
  for (const { major, version, canary } of targets) {
    const options = canary ? { versionPolicy: "canary" as const } : {};
    const { postgres: createCore } = (await import(`../src/analysis/core/${major}.js`)) as { postgres: Factory };
    const { postgres: createSelected } = (await import(`../src/analysis/${major}.js`)) as { postgres: Factory };
    const core = createCore(options),
      selected = createSelected(options),
      full = postgres(options);
    const schema = core.validateSnapshot({
      formatVersion: 1,
      dialect: "postgres",
      server: postgresServerEvidence(version),
      tables: {},
    });
    await it(`${major} preserves maintained rules throughout the independent invocation inventory`, async () => {
      const inventory = JSON.parse(
        await readFile(
          new URL(`../../../test/fixtures/language-audit/postgres-${major}.json`, import.meta.url),
          "utf8",
        ),
      );
      let count = 0,
        resolved = 0,
        omitted = 0;
      for (const row of inventory.categories.functions.rows)
        for (const sql of recognitionQueries(row)) {
          const expected = full.analyze(sql, schema);
          strict.deepEqual(selected.analyze(sql, schema), expected, sql);
          const unsupported = expected.diagnostics.some(
            (item) =>
              item.code === "TSQ202" && item.severity === "warning" && item.message.startsWith("Unknown function "),
          );
          const actual = core.analyze(sql, schema);
          count++;
          if (unsupported) {
            omitted++;
            strict.ok(
              actual.diagnostics.some((item) => item.code === "TSQ408" && item.severity === "error"),
              sql,
            );
            strict.deepEqual(actual.parameters, expected.parameters, sql);
            strict.deepEqual(actual.columns, expected.columns, sql);
            strict.deepEqual(
              actual.diagnostics.filter((item) => item.code !== "TSQ408"),
              expected.diagnostics.filter(
                (item) => !(item.code === "TSQ202" && item.message.startsWith("Unknown function ")),
              ),
              sql,
            );
          } else {
            strict.deepEqual(actual, expected, sql);
            resolved++;
          }
        }
      strict.ok(count > 0 && resolved > 0 && omitted > 0);
      for (const sql of [
        "SELECT COUNT(*), SUM(1), COALESCE($1::integer, 1)",
        "WITH items AS (SELECT 1 AS id) SELECT id FROM items WHERE id>$1",
        "SELECT jsonb_build_object('id', $1::integer) AS value",
        "SELECT 1::integer + $1::integer AS value UNION ALL SELECT 2",
      ])
        strict.deepEqual(core.analyze(sql, schema), full.analyze(sql, schema), sql);
    });
    await it(`${major} fails closed on mismatched/missing evidence and preserves canary policy`, () => {
      const other = targets.find((item) => item.major !== major)!;
      const mismatched = { ...schema, server: postgresServerEvidence(other.version) };
      strict.throws(() => core.validateSnapshot(mismatched), /selected PostgreSQL analyzer requires major/u);
      strict.throws(
        () => selected.validateSnapshot({ ...schema, version: undefined, server: undefined }),
        /selected PostgreSQL analyzer requires major/u,
      );
      strict.equal(core.analyze("SELECT 1", mismatched).diagnostics[0]?.code, "TSQ402");
      const missing = { formatVersion: 1, dialect: "postgres", tables: {} } as const;
      strict.equal(core.analyze("SELECT 1", missing).diagnostics[0]?.code, "TSQ402");
      if (canary) {
        strict.deepEqual(createCore().analyze("SELECT 1", schema), postgres().analyze("SELECT 1", schema));
        strict.ok(
          Object.values(createCore().resolveCapabilities!(schema)).some(
            (state) =>
              state.level === "conservative" &&
              state.evidence.some(
                (item) => item.kind === "policy" && item.key === "versionChannel" && item.value === "stable",
              ),
          ),
        );
      }
      const unsupported = core.analyze("SELECT pg_catalog.md5($1::text) AS value", schema);
      strict.equal(unsupported.diagnostics[0]?.code, "TSQ408");
      strict.match(unsupported.diagnostics[0]!.message, /generate a qualified query contract/u);
      strict.deepEqual(
        unsupported.parameters,
        full.analyze("SELECT pg_catalog.md5($1::text) AS value", schema).parameters,
      );
    });
    await it(`${major} loads only its catalog without the compatibility registry or introspection`, async () => {
      const path = (entry: string) => JSON.stringify(fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url)));
      const build = (entry: string) =>
        esbuild.build({
          stdin: {
            contents: `export {postgres} from ${path(entry)}`,
            loader: "ts",
            resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
          },
          bundle: true,
          minify: true,
          platform: "node",
          format: "esm",
          write: false,
          metafile: true,
        });
      const coreGraph = await build(`analysis/core/${major}`),
        compat = await build("analysis");
      const inputs = Object.keys(coreGraph.metafile.inputs);
      strict.ok(inputs.some((input) => input.endsWith(`/catalog/generated/${major}.ts`)));
      for (const other of targets)
        if (other.major !== major)
          strict.ok(!inputs.some((input) => input.endsWith(`/catalog/generated/${other.major}.ts`)));
      for (const suffix of [
        "/catalog/index.ts",
        "/compatibility-resolver.ts",
        "/type-resolution.ts",
        "/extensions.ts",
        "/postgres/src/provider.ts",
        "/postgres/src/pg.ts",
      ])
        strict.ok(!inputs.some((input) => input.endsWith(suffix)), suffix);
      strict.ok(coreGraph.outputFiles[0].contents.byteLength < compat.outputFiles[0].contents.byteLength);
    });
  }
  await it("admits only the unmapped-routine diagnostic for native evidence", () => {
    const owner = createPostgresContractReconciler();
    const range = { start: 0, end: 1, line: 1, column: 1 };
    const claim = createStaticQueryClaim({
      sql: "SELECT 1",
      context: {
        grammar: owner.grammar,
        ...postgresContractIdentity(),
        schemaHash: "0".repeat(64),
        databaseContextHash: "0".repeat(64),
        typePolicyHash: "0".repeat(64),
      },
      analysis: {
        columns: [],
        parameters: [],
        semantics: unknownQuerySemantics(range, "Omitted rule"),
        diagnostics: [{ code: "TSQ408", severity: "error", message: "unmapped", range }],
      },
    });
    strict.equal(owner.classify(claim).status, "unsupported");
    strict.equal(
      owner.classify({ ...claim, diagnostics: [...claim.diagnostics, { code: "TSQ403", severity: "error" }] }).status,
      "invalid",
    );
  });
});
