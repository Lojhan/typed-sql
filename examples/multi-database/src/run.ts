import { typePolicy as postgresTypePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { typePolicy as sqliteTypePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { connectionString } from "../postgres/typed-sql.config.js";
import { setupSqliteDatabase } from "../sqlite/setup.js";
import { databasePath } from "../sqlite/typed-sql.config.js";
import { getCustomerProfile, setCustomerPreference } from "./service.js";

export async function runMultiDatabaseExample() {
  await setupSqliteDatabase();
  const postgres = await createPgDatabase({ connectionString, typePolicy: postgresTypePolicy });
  const sqlite = await createNodeSqliteDatabase({ path: databasePath, typePolicy: sqliteTypePolicy });
  const databases = { postgres, sqlite };

  try {
    const before = await getCustomerProfile(databases, 1n);
    const updatedPreference = await setCustomerPreference(databases, 1n, "light", false);
    const after = await getCustomerProfile(databases, 1n);
    return { before, updatedPreference, after };
  } finally {
    await Promise.all([postgres.close(), sqlite.close()]);
  }
}
