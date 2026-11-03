import { typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { typePolicy as sqliteTypePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { connectionString } from "../postgres/typed-sql.config.js";
import { setupSqliteDatabase } from "../sqlite/setup.js";
import { databasePath } from "../sqlite/typed-sql.config.js";
import { getUserProfile, setUserProfile } from "./service.js";

export async function runMultiDatabaseExample() {
  await setupSqliteDatabase();
  const postgres = await createPgDatabase({ connectionString, typePolicy: postgresTypePolicy });
  const sqlite = await createNodeSqliteDatabase({ path: databasePath, typePolicy: sqliteTypePolicy });
  const databases = { postgres, sqlite };

  try {
    const before = await getUserProfile(databases, 1n);
    const updatedProfile = await setUserProfile(databases, 1n, "light", false);
    const after = await getUserProfile(databases, 1n);
    return { before, updatedProfile, after };
  } finally {
    await Promise.all([postgres.close(), sqlite.close()]);
  }
}
