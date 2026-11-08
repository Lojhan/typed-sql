import { sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { duckdb } from "../src/analysis.js";
import { typePolicy } from "../src/index.js";
import { formatDuckDBType } from "../src/native-types.js";
import { createNodeDuckDBDatabase, duckDBTypeFromSDK } from "../src/node-api.js";
import { DuckDBSchemaProvider } from "../src/provider.js";

const sdk =
  process.env.TYPED_SQL_DUCKDB_SDK === "15" ? await import("duckdb-node-15") : await import("@duckdb/node-api");
const version = process.env.TYPED_SQL_DUCKDB_SDK === "15" ? "1.5.6" : "2.0.0";
await it(`qualifies DML aliases and conflict parameters on native DuckDB ${version}`, async () => {
  strict.equal(sdk.version(), `v${version}`);
  const instance = await sdk.DuckDBInstance.create(),
    connection = await instance.connect();
  const database = await createNodeDuckDBDatabase({ connection, sdkImporter: async () => sdk });
  try {
    await database.queryable.all("CREATE TABLE users(id BIGINT PRIMARY KEY,email VARCHAR NOT NULL,team_id INTEGER)");
    const snapshot = await new DuckDBSchemaProvider({ client: database.queryable }).introspect();
    const queries = [
      "SELECT id FROM users WHERE id IN($1,$2)",
      "SELECT id FROM users WHERE id NOT IN($1,$2)",
      "SELECT id FROM users WHERE id BETWEEN $1 AND $2",
      "SELECT id FROM users WHERE $1 BETWEEN id AND $2",
      "INSERT INTO users(id,email) VALUES($1,$2) RETURNING id,email",
      "INSERT INTO users AS u(id,email) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET email=excluded.email WHERE u.id=$3 RETURNING u.id,u.email",
      "UPDATE users AS u SET email=$1 WHERE u.id=$2 RETURNING u.id,u.email",
      "DELETE FROM users AS u WHERE u.id=$1 RETURNING u.id",
      "INSERT OR IGNORE INTO users(id,email) VALUES($1,$2) RETURNING id",
      "INSERT OR REPLACE INTO users(id,email) VALUES($1,$2) RETURNING id",
      "INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id",
      "UPDATE users SET team_id=$1 FROM (SELECT 1::BIGINT AS user_id) t WHERE users.id=t.user_id RETURNING users.id",
      "DELETE FROM users USING (SELECT 1::BIGINT AS user_id) t WHERE users.id=t.user_id RETURNING users.id",
    ];
    for (const text of queries) {
      const analysis = duckdb().analyze(text, snapshot);
      strict.deepEqual(analysis.diagnostics, [], text);
      const native = await connection.prepare(text);
      try {
        strict.deepEqual(
          analysis.parameters.map((parameter) => parameter.databaseType),
          Array.from({ length: native.parameterCount }, (_, i) =>
            formatDuckDBType(duckDBTypeFromSDK(native.parameterType(i + 1), sdk)),
          ),
          text,
        );
        strict.deepEqual(
          analysis.columns.map((column) => [column.name, column.databaseType]),
          Array.from({ length: native.columnCount }, (_, i) => [
            native.columnName(i),
            formatDuckDBType(duckDBTypeFromSDK(native.columnType(i), sdk)),
          ]),
          text,
        );
      } finally {
        native.destroySync();
      }
    }
    const compiled = (text: string, values: readonly unknown[]) => {
      const analysis = duckdb().analyze(text, snapshot);
      strict.deepEqual(analysis.diagnostics, [], text);
      const parts = text
        .split(/\$\d+/u)
        .flatMap((part, i) => (i === 0 ? [sql.raw(part)] : [sql.value(values[i - 1]), sql.raw(part)]));
      return withQueryValuePlan(sql`${sql.join(parts, sql.empty)}`, {
        dialect: "duckdb",
        typePolicyHash: calculateTypePolicyHash(typePolicy),
        columns: analysis.columns.map((column) => ({
          name: column.name,
          type: column.runtimeType!,
          nullable: column.nullable,
          databaseType: column.databaseType!,
        })),
        parameters: analysis.parameters.map((parameter) => ({
          index: parameter.index,
          type: parameter.runtimeType!,
          nullable: parameter.nullable,
          databaseType: parameter.databaseType!,
        })),
      });
    };
    strict.deepEqual(await database.all(compiled(queries[4]!, [1n, "first"])), [{ id: 1n, email: "first" }]);
    strict.deepEqual(await database.all(compiled(queries[5]!, [1n, "second", 1n])), [{ id: 1n, email: "second" }]);
    strict.deepEqual(await database.all(compiled(queries[6]!, ["third", 1n])), [{ id: 1n, email: "third" }]);
    strict.deepEqual(await database.all(compiled(queries[7]!, [1n])), [{ id: 1n }]);
    for (const text of [
      "INSERT INTO users(id,email) VALUES(1,'x') ON CONFLICT(id) DO UPDATE SET missing=$1",
      "INSERT INTO users(id,email) VALUES(1,'x') ON CONFLICT(missing) DO NOTHING",
      "INSERT INTO users(id,email) VALUES(1,'x') ON CONFLICT(id) DO UPDATE SET email=excluded.missing",
      "UPDATE users AS u SET email='x' WHERE missing.id=1 RETURNING id",
      "DELETE FROM users AS u WHERE missing.id=1 RETURNING id",
      "INSERT INTO users(id,id) VALUES(1,2)",
      "INSERT INTO users(id,email,team_id) SELECT id,email,team_id",
    ])
      strict.ok(duckdb().analyze(text, snapshot).diagnostics.length, text);
  } finally {
    await database.close();
    connection.closeSync();
    instance.closeSync();
  }
});
