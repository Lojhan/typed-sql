import { typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { typePolicy as sqliteTypePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { describe, it, strict } from "poku";
import { connectionString } from "../postgres/typed-sql.config.js";
import { setupSqliteDatabase } from "../sqlite/setup.js";
import { databasePath } from "../sqlite/typed-sql.config.js";
import { getUserProfile, setUserProfile } from "../src/service.js";

await setupSqliteDatabase();
const postgres = await createPgDatabase({ connectionString, typePolicy: postgresTypePolicy });
const sqlite = await createNodeSqliteDatabase({ path: databasePath, typePolicy: sqliteTypePolicy });
const databases = { postgres, sqlite };

function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainValue(child)]));
}

try {
  await describe("one application with PostgreSQL and SQLite", async () => {
    await it("combines independently inferred rows from both drivers", async () => {
      strict.deepStrictEqual(plainValue(await getUserProfile(databases, 1n)), {
        user: { id: 1n, email: "alice@example.com", display_name: "Alice" },
        profile: { id: 1n, profile: '{"theme":"dark","emailNotifications":true}' },
      });
    });

    await it("keeps writes scoped to the selected database", async () => {
      strict.deepStrictEqual(plainValue(await setUserProfile(databases, 1n, "light", false)), {
        id: 1n,
        profile: '{"theme":"light","emailNotifications":false}',
      });
      strict.deepStrictEqual(plainValue(await getUserProfile(databases, 1n)), {
        user: { id: 1n, email: "alice@example.com", display_name: "Alice" },
        profile: { id: 1n, profile: '{"theme":"light","emailNotifications":false}' },
      });
    });
  });
} finally {
  await Promise.all([postgres.close(), sqlite.close()]);
}
