import { readFile } from "node:fs/promises";
import { describe, it, strict } from "poku";
import { assertOfflineCoreParity, assertPortableCoreGraph } from "../../../test/helpers/offline-core.js";
import { sqlserver as core } from "../src/analysis/core.js";
import { sqlserver } from "../src/browser.js";
import { sqlServerServerEvidence } from "../src/capabilities.js";
import { SQLSERVER_LANGUAGE_SUPPORT } from "../src/support.js";

await describe("SQL Server maintained offline core", async () => {
  for (const major of SQLSERVER_LANGUAGE_SUPPORT.engineMajors) {
    const inventory = JSON.parse(
      await readFile(new URL(`../../../test/fixtures/language-audit/sqlserver-${major}.json`, import.meta.url), "utf8"),
    );
    for (const compatibilityLevel of SQLSERVER_LANGUAGE_SUPPORT.compatibilityLevels.filter(
      (level) => level <= major * 10,
    )) {
      const schema = {
        formatVersion: 1,
        dialect: "sqlserver",
        tables: {},
        server: sqlServerServerEvidence(`${major}.0.1.0`, {
          compatibilityLevel,
          collation: "Latin1_General_100_CI_AS_SC",
          defaultSchema: "dbo",
          quotedIdentifier: true,
          ansiWarnings: true,
          arithAbort: true,
          concatNullYieldsNull: true,
          dateFirst: 7,
          dateFormat: "mdy",
          language: "us_english",
        }),
      } as const;
      await it(`preserves engine ${major} / compatibility ${compatibilityLevel} reference invocations`, () => {
        assertOfflineCoreParity({
          full: sqlserver(),
          core: core(),
          schema,
          rows: inventory.categories.functions.rows,
          omitted: (item) => item.code === "TSQ105" && item.message.startsWith("Unknown or ambiguous function "),
        });
        for (const sql of [
          "SELECT IIF(1=1, @__typed_sql_1, 0) AS value",
          "SELECT ABS(1,2)",
          "SELECT IIF() AS value",
          "SELECT JSON_OBJECT('id':1) AS value",
          "SELECT DATETRUNC(day, CAST('2024-01-01' AS datetime2)) AS value",
        ])
          strict.deepEqual(core().analyze(sql, schema), sqlserver().analyze(sql, schema), sql);
        const malformedSql = "SELECT IIF(CAST(@__typed_sql_1 AS bit)) AS value";
        const malformed = core().analyze(malformedSql, schema);
        strict.equal(malformed.columns[0]?.tsType, "unknown");
        strict.equal(malformed.parameters.length, 1);
        strict.equal(malformed.parameters[0]?.index, 1);
        strict.equal(malformed.parameters[0]?.tsType, "boolean");
        const occurrence = core().parameterOccurrences!(malformedSql, schema)[0]!;
        strict.equal(occurrence.index, 1);
        strict.equal(malformedSql.slice(occurrence.range.start, occurrence.range.end), "@__typed_sql_1");
        const arity = malformed.diagnostics.find((item) => item.code === "TSQ202");
        strict.equal(arity?.severity, "error");
        strict.equal(malformedSql.slice(arity!.range.start, arity!.range.end), "IIF(CAST(@__typed_sql_1 AS bit))");
        const sql = "SELECT DEGREES_MISSING(CAST(@__typed_sql_1 AS float)) AS value";
        const actual = core().analyze(sql, schema);
        strict.equal(actual.diagnostics[0]?.code, "TSQ408");
        strict.match(actual.diagnostics[0]!.message, /generate a qualified query contract/u);
        strict.deepEqual(actual.parameters, sqlserver().analyze(sql, schema).parameters);
      });
    }
  }
  await it("keeps the core dependency graph portable", async () => assertPortableCoreGraph("sqlserver", "sqlserver"));
});
