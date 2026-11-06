import { Client } from "pg";
import { describe, it, skip, strict } from "poku";

const connectionString = process.env.TYPED_SQL_TEST_DATABASE_URL ?? process.env.TYPED_SQL_PLAYGROUND_PG_URL;
if (connectionString === undefined) skip("Set a PostgreSQL test URL to verify CONCAT against the database");
const client = new Client({ connectionString });
await client.connect();
try {
  await describe("live PostgreSQL CONCAT semantics", async () => {
    await it("matches mixed and NULL inputs in a read-only transaction", async () => {
      await client.query("BEGIN READ ONLY");
      try {
        const result = await client.query(
          "SELECT CONCAT('abc',2,NULL,true) AS mixed,concat(NULL,NULL) AS empty,pg_catalog.concat($1::int4,$2::text) AS typed,concat(VARIADIC NULL::text[]) AS variadic_null",
          [42, "x"],
        );
        strict.deepEqual(result.rows, [{ mixed: "abc2t", empty: "", typed: "42x", variadic_null: null }]);
        strict.ok(result.fields.every(({ dataTypeID }) => dataTypeID === 25));
      } finally {
        await client.query("ROLLBACK");
      }
    });
    await it("requires an argument and cannot infer the type of an uncast parameter", async () => {
      await strict.rejects(client.query("SELECT concat()"), { code: "42883" });
      await strict.rejects(client.query("SELECT concat($1)", [42]), { code: "42P18" });
    });
  });
} finally {
  await client.end();
}
