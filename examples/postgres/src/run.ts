import { typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { connectionString } from "../typed-sql.config.js";
import { activeAccounts } from "./queries.js";

export async function runPostgresExample() {
  const database = await createPgDatabase({ connectionString, typePolicy });

  try {
    return await database.all(activeAccounts);
  } finally {
    await database.close();
  }
}
