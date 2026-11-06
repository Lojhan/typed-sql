import { it, strict } from "poku";
import { duckdb } from "../src/browser.js";
import { formatDuckDBType } from "../src/native-types.js";
import { createNodeDuckDBDatabase, duckDBTypeFromSDK } from "../src/node-api.js";
import { DuckDBSchemaProvider } from "../src/provider.js";

const legacy = process.env.TYPED_SQL_DUCKDB_SDK === "15";
const sdk = legacy ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = legacy ? "1.5.6" : "2.0.0";
await it(`proves feature-ledger native syntax boundaries on DuckDB ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
  try {
    await database.queryable.all("CREATE TABLE ledger_target(id INTEGER NOT NULL DEFAULT 1)");
    const snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    for (const source of [
      "SELECT x FROM (SELECT 1 AS x)",
      "SELECT a.x,b.y FROM (SELECT 1 AS x) a,LATERAL (SELECT a.x+1 AS y) b",
      "INSERT INTO ledger_target DEFAULT VALUES RETURNING id",
    ]) {
      const analysis = duckdb().analyze(source, snapshot);
      strict.deepEqual(analysis.diagnostics, [], source);
      const result = await connection.run(source);
      try {
        strict.deepEqual(
          analysis.columns.map((column) => [column.name, column.databaseType]),
          Array.from({ length: result.columnCount }, (_, index) => [
            result.columnName(index),
            formatDuckDBType(duckDBTypeFromSDK(result.columnType(index), sdk)),
          ]),
          source,
        );
      } finally {
        result.closeSync();
      }
    }
    for (const source of [
      "SELECT `x` FROM (SELECT 1 AS x)",
      "WITH changed AS(DELETE FROM ledger_target RETURNING id) SELECT id FROM changed",
      "WITH changed AS(INSERT INTO ledger_target VALUES(1) RETURNING id) SELECT id FROM changed",
    ]) {
      const analysis = duckdb().analyze(source, snapshot);
      if (legacy) {
        await strict.rejects(connection.run(source), source);
        strict.ok(analysis.diagnostics.length > 0, source);
        strict.equal(
          duckdb().resolveCapabilities!(snapshot)[source.includes("`") ? "backtickIdentifiers" : "modifyingCtes"]
            ?.level,
          "unsupported",
        );
      } else {
        strict.deepEqual(analysis.diagnostics, [], source);
        const result = await connection.run(source);
        try {
          strict.deepEqual(
            analysis.columns.map((column) => [column.name, column.databaseType]),
            Array.from({ length: result.columnCount }, (_, index) => [
              result.columnName(index),
              formatDuckDBType(duckDBTypeFromSDK(result.columnType(index), sdk)),
            ]),
            source,
          );
          if (source.startsWith("WITH")) strict.equal(analysis.semantics?.operation.value, "write");
        } finally {
          result.closeSync();
        }
      }
    }
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
