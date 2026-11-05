import { it, strict } from "poku";
import { DuckDBSchemaProvider, duckdb } from "../src/index.js";
import { formatDuckDBType } from "../src/native-types.js";
import { adaptDuckDBConnection, duckDBTypeFromSDK } from "../src/node-api.js";
import { createDuckDBDatabase } from "../src/runtime.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`qualifies analytical result shapes on actual DuckDB${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect(),
    database = createDuckDBDatabase({ connection: adaptDuckDBConnection(connection, sdk) });
  const failures: string[] = [];
  try {
    await database.queryable.all("CREATE TABLE users(id BIGINT NOT NULL,email VARCHAR NOT NULL,team_id INTEGER)");
    await database.queryable.all("INSERT INTO users VALUES(1,'a',1),(2,'b',1),(3,'c',NULL)");
    const snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    const queries = [
      "SELECT unnest([{'a':1,'b':{'c':'x'}}],recursive:=true)",
      "SELECT unnest({'a':[1,2],'b':{'c':1}},recursive:=true)",
      "SELECT unnest([[1,2],[3]],max_depth:=1) AS values",
      "SELECT unnest([[1,2],[3]],max_depth:=2) AS value",
      "SELECT unnest([{'a':{'b':1},'c':2}],max_depth:=2)",
      "SELECT * FROM unnest([1,2]) WITH ORDINALITY AS t(value,position)",
      "SELECT * FROM range(3) WITH ORDINALITY AS t(value,position)",
      "SELECT id,row_number() OVER w AS rank FROM users WINDOW w AS(PARTITION BY team_id ORDER BY id) QUALIFY rank=1",
      "FROM users SELECT DISTINCT id",
      "SELECT id FROM users SEMI JOIN users AS u USING(id)",
      "SELECT id FROM users ANTI JOIN users AS u USING(id)",
      "SELECT users.id AS left_id,u.id AS right_id FROM users ASOF LEFT JOIN users AS u ON users.id>=u.id",
      "SELECT users.id AS left_id,u.id AS right_id FROM users POSITIONAL JOIN users AS u",
    ];
    for (const query of queries) {
      const result = await connection.run(query);
      try {
        const native = Array.from({ length: result.columnCount }, (_, i) => [
          result.columnName(i),
          formatDuckDBType(duckDBTypeFromSDK(result.columnType(i), sdk)),
        ]);
        const analysis = duckdb().analyze(query, snapshot);
        const inferred = analysis.columns.map((column) => [column.name, column.databaseType]);
        if (analysis.diagnostics.length)
          failures.push(`${query}: ${analysis.diagnostics.map((d) => d.message).join("; ")}`);
        else if (JSON.stringify(native) !== JSON.stringify(inferred))
          failures.push(`${query}: inferred ${JSON.stringify(inferred)} native ${JSON.stringify(native)}`);
      } finally {
        result.closeSync();
      }
    }
    strict.deepEqual(failures, []);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
