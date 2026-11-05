import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { assertDuckDBSemanticEvidence, duckDBEvidenceDifferences } from "../src/settings.js";
import { duckDBServerEvidence } from "../src/support.js";
import { duckDBRuntimeValueType, duckDBTypeIdentity } from "../src/type-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

await it("requires critical semantic evidence and compares every recorded identity", () => {
  assertDuckDBSemanticEvidence(duckDBServerEvidence("2.0.0"), false);
  for (const evidence of [
    { ...fixtureEvidence("2.0.0"), product: "other" },
    duckDBServerEvidence("2.1.0"),
    fixtureEvidence("2.0.0", { Calendar: "buddhist" }),
    fixtureEvidence("2.0.0", { preserve_identifier_case: "lower_case" }),
    fixtureEvidence("1.5.6", { old_implicit_casting: "true" }),
  ])
    strict.throws(() => assertDuckDBSemanticEvidence(evidence));
  strict.deepEqual(
    duckDBEvidenceDifferences(fixtureEvidence("2.0.0"), {
      ...fixtureEvidence("1.5.6", { extra: "value" }),
      product: "other",
      features: ["extension@v1"],
    }),
    [
      "product",
      "versionKey",
      "features",
      "settings.preserve_identifier_case",
      "settings.extra",
      "settings.old_implicit_casting",
    ],
  );
});
await it("validates public browser helpers and physical runtime type contracts", () => {
  const dialect = duckdb();
  strict.equal(dialect.placeholder(65535), "$65535");
  for (const index of [0, -1, 1.5, 65536, Number.NaN]) strict.throws(() => dialect.placeholder(index));
  strict.equal(dialect.quoteIdentifier('a"b'), '"a""b"');
  strict.equal(
    dialect.runtimeValueType?.({ databaseType: "BIGINT", tsType: "bigint", nullable: true }, dialect.defaultTypePolicy),
    "bigint",
  );
  strict.equal(duckDBRuntimeValueType({ tsType: "unknown", nullable: true }), "unknown");
  strict.equal(duckDBTypeIdentity({ kind: "scalar", name: "INTEGER" }), "duckdb:INTEGER");
  const snapshot = {
    formatVersion: 1 as const,
    dialect: "duckdb" as const,
    tables: {},
    server: fixtureEvidence("1.5.6"),
  };
  strict.equal(dialect.analyze("SELECT `name` FROM missing", snapshot).diagnostics[0]?.code, "TSQ401");
  strict.throws(() => dialect.validateSnapshot(null));
});
