import { describe, it, strict } from "poku";
import {
  sqliteCheckExpressions,
  sqliteColumnCollation,
  sqliteGeneratedExpression,
  sqliteIndexExpression,
  sqliteIndexPredicate,
  sqliteVirtualTableModule,
} from "../src/schema-sql.js";

await describe("SQLite schema SQL evidence", async () => {
  await it("extracts quoted generated columns, collations, and nested checks", () => {
    const definition = `
      CREATE TABLE sample (
        "source,value" TEXT COLLATE "NOCASE",
        result TEXT GENERATED ALWAYS AS (printf('%s,%s', "source,value", lower('x'))) STORED,
        CHECK (length("source,value") > 0),
        CONSTRAINT valid_result CHECK (result IS NULL OR instr(result, ',') > 0)
      ) STRICT
    `;
    strict.strictEqual(sqliteColumnCollation(definition, "source,value"), "NOCASE");
    strict.strictEqual(sqliteGeneratedExpression(definition, "result"), `printf('%s,%s', "source,value", lower('x'))`);
    strict.deepStrictEqual(sqliteCheckExpressions(definition), [
      `length("source,value") > 0`,
      `result IS NULL OR instr(result, ',') > 0`,
    ]);
  });

  await it("extracts individual index expressions and partial predicates", () => {
    const definition =
      "CREATE UNIQUE INDEX selected ON sample(lower(name) COLLATE nocase DESC, score + abs(delta)) " +
      "WHERE active = 1 AND note <> 'WHERE'";
    strict.strictEqual(sqliteIndexExpression(definition, 0), "lower(name)");
    strict.strictEqual(sqliteIndexExpression(definition, 1), "score + abs(delta)");
    strict.strictEqual(sqliteIndexPredicate(definition), "active = 1 AND note <> 'WHERE'");
  });

  await it("extracts quoted virtual-table module names", () => {
    strict.strictEqual(sqliteVirtualTableModule('CREATE VIRTUAL TABLE docs USING "fts5"(body)'), "fts5");
  });
});
