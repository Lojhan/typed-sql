import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { loadDuckDBCatalog } from "../src/catalog/generated/profile-loader.js";
import { duckDBBuiltinCatalog } from "../src/catalog/index.js";
import { duckDBBuiltinFormalNames, duckDBBuiltinParameterBindings } from "../src/catalog/profile.js";
import { loadDuckDBAnalyzer } from "../src/selected-analysis.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const ledger = JSON.parse(await readFile(new URL("../../../grammar/features/ledger.json", import.meta.url), "utf8"));
const versions = [...ledger.dialects.duckdb.stable, ...ledger.dialects.duckdb.canary].map(
  ({ minimum, maximum }: { minimum: string; maximum: string }) => {
    strict.equal(minimum, maximum);
    return minimum;
  },
);
await describe("selected DuckDB analysis profiles", async () => {
  await it("preserves retained signatures, parameter metadata, casts, common types and complete analysis", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const compatibility = duckdb();
    const queries = [
      "SELECT power(y := 2, x := 3) AS value",
      "SELECT round(precision := 2, x := 123.456::DOUBLE) AS value",
      "SELECT lower($1) AS label, abs(42) AS amount",
      "SELECT list_value(1::SMALLINT, 2::BIGINT) AS values",
      "SELECT coalesce(NULL::DECIMAL(10,2), 1.25) AS amount",
      "SELECT struct_pack(a := 1, b := 'x') AS value",
      "SELECT * FROM range(1, 3)",
      "SELECT * FROM range(NULL::BIGINT)",
      "SELECT 1::INTEGER AS value UNION ALL SELECT 2::UBIGINT",
      "SELECT list_transform([1,2], x -> x + 1) AS values",
      "SELECT sum_no_overflow(1::BIGINT) AS amount",
      "SELECT unknown_routine(1) AS value",
      "SELECT (",
    ];
    for (const version of versions) {
      const entry = `./analysis/profiles/${version}`;
      strict.equal(manifest.exports[entry], `./dist/packages/duckdb/src/analysis/generated/${version}.js`);
      strict.ok(manifest.typedSql.developmentEntrypoints.includes(entry));
      const profile = await loadDuckDBCatalog(version);
      const raw = await import(`../src/catalog/generated/${version}.js`);
      const common = await import(`../src/catalog/generated/common-${version}.js`);
      strict.deepEqual(profile.signatures, raw.signatures);
      strict.deepEqual(profile.commonTypes, common.commonTypes);
      strict.deepEqual(profile.expressionTypes, common.expressionTypes);
      strict.deepEqual(profile.namedArgumentBinding, raw.namedArgumentBinding);
      strict.deepEqual(profile.keywordInvocationForms, raw.keywordInvocationForms);
      for (const [index, signature] of profile.signatures.entries()) {
        strict.deepEqual(duckDBBuiltinFormalNames(signature), raw.parameterNames[index]);
        strict.deepEqual(duckDBBuiltinParameterBindings(signature), raw.parameterBindings[index]);
      }
      for (const [source, target] of raw.implicitCasts) strict.ok(profile.scalarImplicitCast(source, target));
      const selected = await loadDuckDBAnalyzer({ version });
      const fixed = await import(`../src/analysis/generated/${version}.js`);
      strict.deepEqual(Object.keys(fixed), ["duckdb"]);
      const schema = { formatVersion: 1, dialect: "duckdb", server: fixtureEvidence(version), tables: {} } as const;
      for (const sql of queries) {
        const expected = compatibility.analyze(sql, schema);
        strict.deepEqual(selected.analyze(sql, schema), expected, `${version}: ${sql}`);
        strict.deepEqual(fixed.duckdb().analyze(sql, schema), expected, `${version} fixed: ${sql}`);
      }
      const selectedPolicy = await loadDuckDBAnalyzer({
        version,
        typePolicy: { ...defaultDuckDBTypePolicy, json: "unknown" },
      });
      strict.deepEqual(
        selectedPolicy.analyze("SELECT '{}'::JSON AS value", schema),
        duckdb({ typePolicy: { ...defaultDuckDBTypePolicy, json: "unknown" } }).analyze(
          "SELECT '{}'::JSON AS value",
          schema,
        ),
      );
      strict.equal(selected.placeholder(2), "$2");
      strict.deepEqual(
        selected.parameterOccurrences!("SELECT $2, $1", schema),
        compatibility.parameterOccurrences!("SELECT $2, $1", schema),
      );
    }
  });
  await it("fails closed on missing and mismatched exact evidence and rejects unsupported loading", async () => {
    for (const version of ["", "unqualified", "toString", "__proto__", "constructor", "1.5", "1.5.7", "2.0.1"]) {
      await strict.rejects(loadDuckDBAnalyzer({ version }), RangeError);
      strict.deepEqual(duckDBBuiltinCatalog(version), []);
    }
    for (const version of versions) {
      const selected = await loadDuckDBAnalyzer({ version });
      for (const server of [
        undefined,
        fixtureEvidence(versions.find((other) => other !== version)!),
        { ...fixtureEvidence(version), versionKey: "unqualified" },
      ]) {
        const result = selected.analyze("SELECT abs(1) AS value", {
          formatVersion: 1,
          dialect: "duckdb",
          tables: {},
          ...(server === undefined ? {} : { server }),
        });
        strict.deepEqual(result.columns, []);
        strict.deepEqual(result.parameters, []);
        strict.equal(result.diagnostics[0]?.code, "TSQ402");
        strict.equal(result.semantics?.operation.value, "unknown");
      }
    }
  });
});
