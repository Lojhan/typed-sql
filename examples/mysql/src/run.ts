import { typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { connectionUri } from "../typed-sql.config.js";
import { activeAccounts } from "./queries.js";

export async function runMySqlExample() {
  const database = await createMySql2Database({ connectionUri, typePolicy });

  try {
    return await database.all(activeAccounts);
  } finally {
    await database.close();
  }
}
