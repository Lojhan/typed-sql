import { it, strict } from "poku";
import { DuckDBSchemaProvider, duckdb } from "../src/analysis.js";
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
      "SELECT ID FROM users",
      "DESCRIBE users",
      "DESCRIBE SELECT id FROM users",
      "SUMMARIZE users",
      "SUMMARIZE SELECT id FROM users",
      "SELECT CASE WHEN id>1 THEN email ELSE NULL END AS value FROM users",
      "SELECT CASE team_id WHEN 1 THEN 42 ELSE NULL END AS value FROM users",
      "SELECT id BETWEEN 1 AND 3 AS value,id NOT BETWEEN 1 AND 3 AS inverse FROM users",
      "SELECT id IN (1,2) AS value,id NOT IN (1,2) AS inverse FROM users",
      "SELECT EXISTS(SELECT 1 FROM users) AS value,NOT EXISTS(SELECT 1 FROM users) AS inverse",
      "SELECT (SELECT min(id) FROM users) AS value",
      "SELECT TRY_CAST(email AS INTEGER) AS value FROM users",
      "SELECT CAST(id AS VARCHAR) AS value FROM users",
      "SELECT DATE '2026-11-05' AS day,TIME '12:30:00' AS time,INTERVAL '1 day' AS duration",
      "SELECT CURRENT_DATE AS day,CURRENT_TIMESTAMP AS instant,LOCALTIME AS time",
      "SELECT [1,2,3][:2] AS prefix,[1,2,3][2:] AS suffix,[1,2,3][1:3:2] AS stride",
      "SELECT row(1,'x')[2] AS value",
      "SELECT {'a':{'b':1}}.a.b AS value",
      "SELECT union_value(n:=1).n AS value",
      "SELECT (MAP {'a':1})['a'] AS value",
      "SELECT [x+1 FOR x IN [1,2] IF x>1] AS value",
      "SELECT list_reduce([1,2],lambda a,b:a+b,10) AS value",
      "SELECT list_transform([1,2],lambda x,i:x+i) AS value",
      "SELECT * EXCLUDE(team_id) REPLACE(upper(email) AS email) FROM users",
      "SELECT * EXCLUDE(team_id) RENAME(email AS address) FROM users",
      "SELECT * REPLACE(upper(email) AS EMAIL) FROM users",
      ...(version === "2.0.0" ? ["SELECT * RENAME(email AS first,email AS second) FROM users"] : []),
      "SELECT * RENAME(missing AS x) FROM users",
      "SELECT id AS first FROM users UNION ALL BY NAME SELECT email AS second FROM users",
      "SELECT id FROM users INTERSECT ALL SELECT id FROM users",
      "SELECT id FROM users EXCEPT SELECT id FROM users",
      "SELECT t.id FROM users t NATURAL JOIN users u",
      "WITH a AS(SELECT 1 AS id),b AS(SELECT id+1 AS id FROM a) SELECT id FROM b",
      "SELECT u.id FROM users u WHERE EXISTS(SELECT 1 FROM users t WHERE t.id=u.id)",
      "SELECT true",
      "SELECT false",
      "SELECT NULL",
      "SELECT 'it''s'",
      "SELECT -1",
      "SELECT -1.20",
      "SELECT +001",
      "SELECT -170141183460469231731687303715884105728",
      "SELECT -9223372036854775808",
      "SELECT -2147483648",
      "SELECT [NULL] AS value",
      "SELECT array_value(NULL,NULL) AS value",
      "SELECT {'a':NULL} AS value",
      "SELECT row(NULL,NULL) AS value",
      "SELECT map([1],[NULL]) AS value",
      ...[
        "DECIMAL(4,2)",
        "TIMESTAMPTZ",
        "TIMETZ",
        "DOUBLE",
        "DATE",
        "UUID",
        "JSON",
        "INTERVAL",
        "BIT",
        "BLOB",
        "UHUGEINT",
        "USMALLINT",
        "UBIGINT",
        "TIMESTAMP_NS",
        "TIMESTAMP_MS",
        "TIMESTAMP_S",
      ].map((type) => `SELECT CAST(NULL AS ${type})`),
      "SELECT 001",
      "SELECT 1+2",
      "SELECT NOT true",
      "SELECT 1::BIGINT",
      "SELECT -1::TINYINT",
      "SELECT [1,2]",
      "SELECT {'a':1}",
      "SELECT count(*) FROM users",
      "SELECT SUM(ID) FROM users",
      "SELECT upper('x')",
      "SELECT coalesce(NULL,1)",
      "SELECT unnest([1,2])",
      "SELECT [1,2][1]",
      "SELECT ID+1 FROM users",
      "WITH RECURSIVE n(x) AS(SELECT 1::INTEGER UNION ALL SELECT (x+1)::BIGINT FROM n WHERE x<3) SELECT x FROM n",
      "SELECT t.id AS left_id,u.id AS right_id,id AS merged_id FROM users AS t FULL JOIN users AS u USING(id)",
      "SELECT id,u.email AS left_email,t.email AS right_email FROM users u RIGHT JOIN users t USING(id)",
      "SELECT id,u.email AS left_email,t.email AS right_email FROM users u LEFT JOIN users t USING(id)",

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
      "DESCRIBE SELECT missing FROM users",
      "SUMMARIZE SELECT missing FROM users",
      "SELECT * REPLACE(email AS missing) FROM users",
      "SELECT * REPLACE(email AS email) RENAME(email AS x) FROM users",
      "SELECT * REPLACE(email AS email,email AS email) FROM users",
      ...(version === "1.5.6" ? ["SELECT * RENAME(email AS first,email AS second) FROM users"] : []),
      "SELECT * REPLACE(email AS email) EXCLUDE(team_id) FROM users",
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
