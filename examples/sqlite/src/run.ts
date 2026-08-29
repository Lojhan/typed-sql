import { typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { databasePath } from "../typed-sql.config.js";
import { activeAccounts } from "./queries.js";

export async function runSqliteExample() {
  const database = await createNodeSqliteDatabase({ path: databasePath, typePolicy });

  try {
    return await database.all(activeAccounts);
  } finally {
    await database.close();
  }
}
