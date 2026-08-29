import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { accountById, projectsByOwner } from "./queries.js";

export async function loadAccountWorkspace(database: MySqlDatabase, accountId: bigint) {
  const [accounts, projects] = await database.batch([accountById(accountId), projectsByOwner(accountId)]);
  return { account: accounts[0], projects };
}
