import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { postgres } from "../src/analysis.js";
import { nativeSignatures } from "../src/catalog/generated/native.js";
import { loadPostgresNativeSignatures } from "../src/catalog/generated/native-loader.js";
import { postgresNativeOverloads } from "../src/catalog/native-resolution.js";
import { loadPostgresAnalyzer } from "../src/selected-analysis.js";
import { defaultPostgresTypePolicy } from "../src/type-policy.js";

const ledger = JSON.parse(await readFile(new URL("../../../grammar/features/ledger.json", import.meta.url), "utf8"));
const majors = [...ledger.dialects.postgres.stable, ...ledger.dialects.postgres.canary].map(
  ({ minimum, maximum }: { minimum: string; maximum: string }) => {
    strict.equal(minimum, maximum);
    return Number(minimum);
  },
);
await describe("selected PostgreSQL native profiles", async () => {
  await it("preserves every retained signature and the compatibility analyzer's complete results", async () => {
    strict.deepEqual(Object.keys(nativeSignatures).map(Number), majors);
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const major of majors) {
      const entry = `./analysis/profiles/${major}`;
      strict.equal(manifest.exports[entry], `./dist/packages/postgres/src/analysis/generated/${major}.js`);
      strict.ok(manifest.typedSql.developmentEntrypoints.includes(entry));
    }
    const compatibility = postgres({ versionPolicy: "canary" });
    const queries = [
      "SELECT lpad($2, $1, $3) AS padded, abs(42) AS magnitude",
      "SELECT concat('x', NULL, 2) AS combined, lower(NULL::text) AS absent",
      "SELECT make_interval(days => 1) AS duration",
      "SELECT crc32c('x'::bytea) AS checksum",
      "SELECT lower(1) AS invalid",
      "SELECT pg_catalog.text($1) AS label, int4('2') AS amount",
      "SELECT pg_backend_pid() AS process",
      "SELECT count(*) AS count FROM missing_relation",
      "SELECT (",
    ];
    for (const major of majors) {
      const signatures = await loadPostgresNativeSignatures(major);
      strict.deepEqual(signatures, nativeSignatures[major], String(major));
      const selected = await loadPostgresAnalyzer({ major, versionPolicy: "canary" });
      const fixed = await import(`../src/analysis/generated/${major}.js`);
      strict.deepEqual(Object.keys(fixed), ["postgres"]);
      const fixedAnalyzer = fixed.postgres({ versionPolicy: "canary" });
      const schema = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
      strict.equal(selected.id, compatibility.id);
      strict.equal(selected.grammarVersion, compatibility.grammarVersion);
      for (const sql of queries) {
        strict.deepEqual(selected.analyze(sql, schema), compatibility.analyze(sql, schema), `${major}: ${sql}`);
        strict.deepEqual(fixedAnalyzer.analyze(sql, schema), selected.analyze(sql, schema), `${major}: fixed ${sql}`);
      }
      strict.deepEqual(fixed.postgres().analyze(queries[0], schema), postgres().analyze(queries[0]!, schema));
      strict.equal(selected.placeholder(2), "$2");
      strict.equal(selected.quoteIdentifier('a"b'), '"a""b"');
      strict.deepEqual(
        selected.parameterOccurrences!("SELECT $2, :named", schema),
        compatibility.parameterOccurrences!("SELECT $2, :named", schema),
      );
    }
    const selected = await loadPostgresAnalyzer({
      major: majors[0]!,
      typePolicy: { ...defaultPostgresTypePolicy, numeric: "number" },
    });
    const result = selected.analyze("SELECT 1.25::numeric AS value", {
      formatVersion: 1,
      dialect: "postgres",
      version: String(majors[0]),
      tables: {},
    });
    strict.equal(result.columns[0]?.tsType, "number");
  });
  await it("refuses missing, unsupported and mismatched version evidence", async () => {
    for (const major of [0, Math.min(...majors) - 1, Math.max(...majors) + 1, 1.5, NaN, Infinity])
      await strict.rejects(loadPostgresAnalyzer({ major }), RangeError);
    const major = majors[0]!,
      selected = await loadPostgresAnalyzer({ major });
    for (const version of [undefined, "unknown", String(majors[1])]) {
      const result = selected.analyze("SELECT lower('x') AS value", {
        formatVersion: 1,
        dialect: "postgres",
        ...(version === undefined ? {} : { version }),
        tables: {},
      });
      strict.deepEqual(result.columns, []);
      strict.deepEqual(result.parameters, []);
      strict.equal(result.diagnostics[0]?.code, "TSQ402");
      strict.equal(result.semantics?.operation.value, "unknown");
      strict.ok(result.diagnostics[0]!.range.end <= "SELECT lower('x') AS value".length);
    }
  });
  await it("isolates lookup indexes by catalog identity instead of version number", async () => {
    const major = majors[0]!,
      rows = await loadPostgresNativeSignatures(major),
      schema = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
    const original = rows.find((row) => row.name === "lower")!;
    const replacement = { ...original, result: "integer" };
    strict.equal(
      postgresNativeOverloads("lower", schema, undefined, { [major]: [original] })[0]?.result,
      original.result,
    );
    strict.equal(postgresNativeOverloads("lower", schema, undefined, { [major]: [replacement] })[0]?.result, "integer");
    strict.equal(postgresNativeOverloads("lower", schema, undefined, {}).length, 0);
    strict.equal(postgresNativeOverloads("lower", schema, "public", { [major]: rows }).length, 0);
  });
});
