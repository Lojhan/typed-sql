import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { createNodeDuckDBDatabase } from "../src/node-api.js";
import { DuckDBSchemaProvider } from "../src/provider.js";
const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`binds qualified functions and diagnoses macro shadowing on native ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
  try {
    await database.queryable.all("CREATE SCHEMA custom");
    await database.queryable.all("CREATE MACRO custom.abs(x) AS 'text'");
    let snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    for (const name of ["abs", "main.abs", "system.main.abs"]) {
      const query = `SELECT ${name}(1)`;
      const result = await connection.run(query);
      try {
        strict.equal(result.columnType(0).toString(), "INTEGER");
      } finally {
        result.closeSync();
      }
      const analysis = duckdb().analyze(query, snapshot);
      strict.deepEqual(analysis.diagnostics, [], query);
      strict.equal(analysis.columns[0]?.databaseType, "INTEGER");
      strict.equal(analysis.columns[0]?.name, name === "system.main.abs" ? '"system".main.abs(1)' : `${name}(1)`);
    }
    for (const name of ["bad.abs", "pg_catalog.abs", "memory.main.abs", "system.custom.abs", "too.many.parts.abs"])
      strict.ok(duckdb().analyze(`SELECT ${name}(1) AS value`, snapshot).diagnostics.length, name);
    for (const name of ["custom.abs", "memory.custom.abs"]) {
      const query = `SELECT ${name}(1) AS value`,
        result = await connection.run(query);
      try {
        strict.equal(result.columnType(0).toString(), "VARCHAR");
      } finally {
        result.closeSync();
      }
      strict.equal(duckdb().analyze(query, snapshot).diagnostics[0]?.code, "TSQ401");
    }
    await connection.run("SET search_path='custom,main'");
    const provider = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
    try {
      snapshot = await new DuckDBSchemaProvider({ client: provider.queryable }).introspect();
    } finally {
      await provider.close();
    }
    const result = await connection.run("SELECT abs(1) AS value");
    try {
      strict.equal(result.columnType(0).toString(), "VARCHAR");
    } finally {
      result.closeSync();
    }
    strict.equal(duckdb().analyze("SELECT abs(1) AS value", snapshot).diagnostics[0]?.code, "TSQ401");
    strict.deepEqual(duckdb().analyze("SELECT system.main.abs(1) AS value", snapshot).diagnostics, []);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
