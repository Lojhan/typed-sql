import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { assertOfflineCoreParity, assertPortableCoreGraph } from "../../../test/helpers/offline-core.js";
import { sqlite as core } from "../src/analysis/core.js";
import { sqlite, sqliteServerEvidence } from "../src/analysis.js";
import { SQLITE_LANGUAGE_SUPPORT } from "../src/support.js";

await describe("SQLite maintained offline core", async () => {
  await it("preserves reference and live inventory outcomes under supported version/compile profiles", async () => {
    for (const fixture of ["sqlite-live", `sqlite-reference-${SQLITE_LANGUAGE_SUPPORT.maximum}`]) {
      const inventory = JSON.parse(
        await readFile(new URL(`../../../test/fixtures/language-audit/${fixture}.json`, import.meta.url), "utf8"),
      );
      for (const version of [SQLITE_LANGUAGE_SUPPORT.minimum, SQLITE_LANGUAGE_SUPPORT.maximum]) {
        const schema = {
          formatVersion: 1,
          dialect: "sqlite",
          tables: {},
          server: sqliteServerEvidence(version, ["ENABLE_MATH_FUNCTIONS"]),
        } as const;
        assertOfflineCoreParity({
          full: sqlite(),
          core: core(),
          schema,
          rows: inventory.categories.functions.rows,
          omitted: (item) =>
            item.code === "TSQ202" && item.severity === "warning" && item.message.startsWith("Unknown function "),
        });
      }
    }
  });
  await it("retains ordered parameters and compile-option/version/arity errors", () => {
    const schema = {
      formatVersion: 1,
      dialect: "sqlite",
      tables: {},
      server: sqliteServerEvidence(SQLITE_LANGUAGE_SUPPORT.maximum, []),
    } as const;
    const sql = "SELECT subtype(CAST(? AS TEXT)) AS value";
    const actual = core().analyze(sql, schema);
    strict.equal(actual.diagnostics[0]?.code, "TSQ408");
    strict.match(actual.diagnostics[0]!.message, /generate a qualified query contract/u);
    strict.deepEqual(actual.parameters, sqlite().analyze(sql, schema).parameters);
    for (const source of [
      "SELECT acos(1)",
      "SELECT abs(1,2)",
      "SELECT coalesce(?, 1)",
      "WITH RECURSIVE items(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM items WHERE id<3) SELECT id FROM items",
    ])
      strict.deepEqual(core().analyze(source, schema), sqlite().analyze(source, schema), source);
    for (const server of [sqliteServerEvidence("3.39.0", []), sqliteServerEvidence("3.99.0", [])]) {
      const target = { ...schema, server };
      strict.deepEqual(
        core().analyze("SELECT concat('a','b')", target),
        sqlite().analyze("SELECT concat('a','b')", target),
      );
    }
  });
  await it("keeps the core dependency graph portable", async () => assertPortableCoreGraph("sqlite", "sqlite"));
});
