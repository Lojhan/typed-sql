import { DatabaseSync } from "node:sqlite";
import { rowTypeLiteral } from "@typed-sql/core";
import { it, strict } from "poku";
import { sqlite } from "../src/analysis.js";
import { sqliteAffinity } from "../src/catalog/coercions.js";
import { nodeSqlite } from "../src/node-sqlite.js";

await it("matches native ASCII folding for functions, keywords, types, and schema columns", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      'CREATE TABLE sample (id "ıNTEGER" PRIMARY KEY, k INTEGER, "K" TEXT); INSERT INTO sample VALUES (NULL, 7, \'kelvin\')',
    );
    const snapshot = await nodeSqlite({ database }).introspect();
    strict.equal(snapshot.tables.sample?.rowidAlias, undefined);
    strict.equal(snapshot.tables.sample?.columns.id?.nullable, true);
    strict.equal(sqliteAffinity("ınt"), "numeric");
    strict.equal(database.prepare('SELECT typeof(CAST(1.5 AS "ınt")) AS kind').get()?.kind, "real");
    for (const sql of [
      'SELECT "changeſ"() AS value',
      'SELECT "last_ınsert_rowıd"() AS value',
      "ſELECT 1 AS value",
      "SELECT caſt(1 AS INTEGER) AS value",
      "SELECT CURRENT_TıMESTAMP AS value",
    ]) {
      strict.throws(() => database.prepare(sql), Error, sql);
      const result = sqlite().analyze(sql, snapshot);
      strict.ok(
        result.diagnostics.some(({ severity }) => severity === "error") ||
          result.columns.some(({ tsType }) => tsType === "unknown"),
        sql,
      );
    }
    for (const sql of [
      "SELECT CHANGES() AS value",
      "SELECT K AS value FROM sample",
      'SELECT "K" AS value FROM sample',
    ]) {
      database.prepare(sql).get();
      strict.deepEqual(sqlite().analyze(sql, snapshot).diagnostics, [], sql);
    }
    database.exec('CREATE TABLE strict_sample (k INTEGER, "K" TEXT) STRICT');
    const strictSnapshot = await nodeSqlite({ database }).introspect();
    strict.equal(
      rowTypeLiteral(sqlite().analyze('SELECT K AS ascii, "K" AS unicode FROM strict_sample', strictSnapshot).columns),
      '{ "ascii": bigint | null; "unicode": string | null; }',
    );
  } finally {
    database.close();
  }
});
