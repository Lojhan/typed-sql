import { describe, it, skip, strict } from "poku";
import { createPostgresDatabase, sql } from "../packages/runtime/src/index.js";
import { introspectPostgres } from "../packages/schema/src/index.js";

const connectionString = process.env.TYPED_SQL_TEST_DATABASE_URL;
if (connectionString === undefined) skip("Set TYPED_SQL_TEST_DATABASE_URL to run live PostgreSQL checks");

const database = createPostgresDatabase({ connectionString });
try {
  await describe("live PostgreSQL integration", async () => {
    await it("introspects and executes on a real connection", async () => {
      const snapshot = await introspectPostgres({ url: connectionString });
      strict.strictEqual(snapshot.dialect, "postgres");
      strict.ok(snapshot.version !== undefined);
      const rows = await database.execute(sql<{ value: number }>`SELECT 1 AS value`);
      strict.strictEqual(rows[0]?.value, 1);
    });

    await it("uses a checked-out transaction client", async () => {
      const value = await database.transaction(async (transaction) => {
        const rows = await transaction.execute(sql<{ value: number }>`SELECT 2 AS value`);
        return rows[0]?.value;
      });
      strict.strictEqual(value, 2);
    });
  });
} finally {
  await database.close();
}
