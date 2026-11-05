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
      "WITH RECURSIVE n(x) AS(SELECT 1::INTEGER UNION ALL SELECT (x+1)::BIGINT FROM n WHERE x<3) SELECT x FROM n",
      "SELECT t.id AS left_id,u.id AS right_id,id AS merged_id FROM users AS t FULL JOIN users AS u USING(id)",

      "SELECT team_id,count(*) AS count FROM users GROUP BY team_id HAVING count>0 ORDER BY team_id",
      "SELECT team_id,count(*) AS count FROM users GROUP BY ROLLUP(team_id)",
      "SELECT email,count(*) AS count FROM users GROUP BY ROLLUP(email)",
      "SELECT team_id,email,count(*) AS count,grouping(team_id,email) AS mask FROM users GROUP BY CUBE(team_id,email)",
      "SELECT team_id,email,count(*) AS count FROM users GROUP BY GROUPING SETS((team_id),(email),())",
      "SELECT percent_rank() OVER(ORDER BY id) AS position,cume_dist() OVER(ORDER BY id) AS cumulative FROM users",

      "SELECT team_id AS team,count(*) AS count FROM users GROUP BY team",
      "SELECT team_id,email FROM users GROUP BY ALL",
      "SELECT team_id+1 AS team,count(*) AS count FROM users GROUP BY 1",
      "SELECT sum(sum(id)) OVER() AS total FROM users GROUP BY team_id",
      "SELECT list_transform(list(id),lambda id:id+1) AS ids FROM users",
      "SELECT list_transform([1],lambda x:sum(id)) AS ids FROM users",
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
    for (const query of [
      "SELECT id,count(*) FROM users",
      "SELECT id FROM users GROUP BY email",
      "SELECT id FROM users WHERE sum(id)>1",
      "SELECT sum(sum(id)) FROM users",
      "SELECT lower(email) OVER() FROM users",
      "SELECT id FROM users QUALIFY id>0",
      "SELECT row_number() OVER() AS rn FROM users WHERE rn>1",
      "SELECT id FROM users GROUP BY 3",
      "SELECT sum(id) FILTER(WHERE row_number() OVER()>1) FROM users",
      "SELECT list_transform([1],lambda x:sum(x)) FROM users",
    ]) {
      let rejected = false;
      try {
        const result = await connection.run(query);
        result.closeSync();
      } catch {
        rejected = true;
      }
      if (!rejected) {
        failures.push(`Native accepted assumed invalid query: ${query}`);
        continue;
      }
      if (!duckdb().analyze(query, snapshot).diagnostics.length)
        failures.push(`Invalid analytical query accepted: ${query}`);
    }
    strict.deepEqual(failures, []);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
