import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { accountById, ordersByCustomer } from "./queries.js";

export async function loadAccountWorkspace(database: MySqlDatabase, accountId: bigint) {
  const [accounts, orders] = await database.batch([accountById(accountId), ordersByCustomer(accountId)]);
  return { account: accounts[0], orders };
}
