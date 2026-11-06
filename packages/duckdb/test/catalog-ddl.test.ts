import { it, strict } from "poku";
import { duckDBGeneratedColumns } from "../src/catalog/ddl.js";

await it("attests generated columns from canonical DDL without reading defaults as generated expressions", () => {
  const columns = duckDBGeneratedColumns(
    `CREATE TEMPORARY TABLE IF NOT EXISTS "a,b"(x INTEGER DEFAULT 1,y INTEGER GENERATED ALWAYS AS((x+1)),"GENERATED" VARCHAR DEFAULT 'GENERATED ALWAYS AS(x)',m MAP(VARCHAR,INTEGER) DEFAULT MAP {'a':1,'b':2},PRIMARY KEY(x),CHECK(x>0));`,
  );
  strict.equal(columns.get("x")?.generated, false);
  strict.equal(columns.get("y")?.generated, true);
  strict.equal(columns.get("y")?.expression, "((x+1))");
  strict.equal(columns.get("generated")?.generated, false);
  strict.equal(columns.size, 4);
  strict.equal(duckDBGeneratedColumns("CREATE TEMP TABLE t(x INTEGER)").get("x")?.generated, false);
  for (const sql of [
    "SELECT 1",
    "CREATE VIEW t AS SELECT 1",
    "CREATE TABLE IF EXISTS t(x INT)",
    "CREATE TABLE t AS SELECT 1",
    "CREATE TABLE t()",
    "CREATE TABLE t(1 INTEGER)",
    "CREATE TABLE t(x INT,x INT)",
    "CREATE TABLE t(x INT GENERATED ALWAYS AS x)",
    "CREATE TABLE t(x INT GENERATED ALWAYS AS((x+1)",
    "CREATE TABLE t(x INT);SELECT 1",
    "CREATE TABLE t(x INT DEFAULT [1,2))",
    `CREATE TABLE t(x INT DEFAULT ${"(".repeat(130)}1${")".repeat(130)})`,
  ])
    strict.throws(() => duckDBGeneratedColumns(sql), Error, sql.slice(0, 100));
});
