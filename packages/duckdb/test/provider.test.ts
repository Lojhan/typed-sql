import * as sdk from "@duckdb/node-api";
import * as sdk15 from "duckdb-node-15";
import { describe, it, strict } from "poku";
import { decodeDuckDBValue } from "../src/codecs.js";
import { parseDuckDBType } from "../src/native-types.js";
import { type DuckDBQueryable, DuckDBSchemaProvider } from "../src/provider.js";

await describe("DuckDB native catalog evidence", async () => {
  for (const driver of [sdk15, sdk])
    await it(`introspects real${driver.version()} catalogs without losing nested type identity`, async () => {
      const instance = await driver.DuckDBInstance.create(),
        connection = await instance.connect();
      const client: DuckDBQueryable = {
        async all<Row extends Record<string, unknown>>(
          sql: string,
          values: readonly unknown[] = [],
        ): Promise<readonly Row[]> {
          const statements = await connection.extractStatements(sql);
          strict.equal(statements.count, 1);
          const prepared = await statements.prepare(0);
          let result: Awaited<ReturnType<typeof prepared.run>> | undefined;
          try {
            for (let i = 0; i < values.length; i++) prepared.bindVarchar(i + 1, String(values[i]));
            result = await prepared.run();
            const types = result.columnTypes().map((type) => parseDuckDBType(type.toString())),
              names = result.columnNames();
            return (await result.getRows()).map((row) =>
              Object.fromEntries(row.map((value, i) => [names[i]!, decodeDuckDBValue(value, types[i]!)])),
            ) as Row[];
          } finally {
            result?.closeSync();
            prepared.destroySync();
          }
        },
      };
      try {
        await client.all(
          "CREATE TABLE users(id BIGINT PRIMARY KEY,email VARCHAR NOT NULL, nested STRUCT(ids BIGINT[], attrs MAP(INTEGER,VARCHAR)), amount DECIMAL(38,4))",
        );
        await client.all("CREATE INDEX users_email ON users(email)");
        await client.all("CREATE SEQUENCE user_ids");
        const snapshot = await new DuckDBSchemaProvider({ client }).introspect();
        strict.equal(snapshot.formatVersion, 2);
        strict.equal(snapshot.server?.versionKey, driver.version().slice(1));
        const users = Object.values(snapshot.tables).find((table) => table.name === "users");
        if (users === undefined) throw new Error("users catalog table missing");
        strict.equal(users.columns.id?.tsType, "bigint");
        strict.equal(users.columns.email?.nullable, false);
        strict.match(users.columns.nested!.tsType, /readonly "attrs"/u);
        if (snapshot.formatVersion === 2) {
          const relation = Object.values(snapshot.relations).find((relation) => relation.name === "users")!;
          strict.equal(relation.columns.id?.position, 0);
          strict.equal(relation.indexes.length, 1);
          strict.ok(relation.constraints.some((constraint) => constraint.kind === "primary-key"));
          strict.ok(Object.values(snapshot.routines).flat().length > 1000);
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    });
});
