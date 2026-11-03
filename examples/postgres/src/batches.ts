import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, ordersByCustomer } from "./queries.js";

export async function loadAccountWorkspace(database: PostgresDatabase, accountId: bigint) {
  const [accounts, orders] = await database.batch([accountById(accountId), ordersByCustomer(accountId)]);
  return { account: accounts[0], orders };
}
