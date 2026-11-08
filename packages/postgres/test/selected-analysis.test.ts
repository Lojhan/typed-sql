import { readFile } from "node:fs/promises";
import { upgradeSchemaSnapshotV1 } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { postgres } from "../src/analysis.js";
import { postgresServerEvidence } from "../src/capabilities.js";
import { loadPostgresCoreCatalog } from "../src/catalog/generated/core-loader.js";
import { nativeSignatures } from "../src/catalog/generated/native.js";
import { loadPostgresNativeSignatures } from "../src/catalog/generated/native-loader.js";
import { postgresNativeOverloads } from "../src/catalog/native-resolution.js";
import { postgresCatalogTypeMapping, scopePostgresCatalog } from "../src/catalog/resolution.js";
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
      "SELECT ARRAY[1, 2]::bigint[] AS values, 1::smallint + 2::bigint AS amount",
      "SELECT coalesce(NULL::numeric, 1.25) AS amount, CASE WHEN true THEN 1 ELSE 2.5 END AS selected",
      "SELECT value FROM generate_series(1, 3) AS value",
      "SELECT jsonb_build_object('x', 1)->>'x' AS label, current_date + 1 AS tomorrow",
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
  await it("keeps core catalog ownership isolated without binding the caller snapshot", async () => {
    const major = majors[0]!;
    const catalog = await loadPostgresCoreCatalog(major);
    const altered = {
      ...catalog,
      types: catalog.types.map((type) => (type.name === "text" ? { ...type, mapping: "number" as const } : type)),
    };
    const schema = Object.freeze({
      formatVersion: 1,
      dialect: "postgres",
      version: String(major),
      tables: {},
    } as const);
    const before = JSON.stringify(schema);
    const normal = scopePostgresCatalog(schema, catalog);
    const different = scopePostgresCatalog(schema, altered);
    strict.equal(postgresCatalogTypeMapping("text", normal), "string");
    strict.equal(postgresCatalogTypeMapping("text", different), "number");
    strict.equal(postgresCatalogTypeMapping("text", normal), "string");
    strict.throws(() => postgresCatalogTypeMapping("text", schema), /explicitly scoped core catalog/u);
    strict.notEqual(normal, schema);
    strict.ok(Object.isFrozen(normal));
    strict.equal(JSON.stringify(schema), before);
    strict.deepEqual(Object.keys(schema), ["formatVersion", "dialect", "version", "tables"]);
    strict.ok(Object.isFrozen(catalog.types));
  });
  await it("preserves catalog ownership through extension snapshot upgrades and contributions", async () => {
    const major = majors[0]!;
    const options = {
      extensions: [
        {
          formatVersion: 1 as const,
          name: "test_extension",
          supportedVersions: ["1"],
          revision: "test",
          casts: [{ sourceType: "extension_type", targetType: "text", context: "explicit" as const }],
        },
      ],
    };
    const selected = await loadPostgresAnalyzer({ major, ...options });
    const compatibility = postgres(options);
    const legacy = { formatVersion: 1, dialect: "postgres", version: String(major), tables: {} } as const;
    const upgraded = {
      ...upgradeSchemaSnapshotV1(legacy),
      dialect: "postgres" as const,
      server: postgresServerEvidence(String(major), ["test_extension:1"]),
    };
    for (const schema of [legacy, upgraded]) {
      const sql = "SELECT '2'::integer + 1 AS value, lower('X') AS label";
      strict.deepEqual(selected.analyze(sql, schema), compatibility.analyze(sql, schema));
      strict.deepEqual(selected.analyze(sql, schema).diagnostics, []);
    }
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
