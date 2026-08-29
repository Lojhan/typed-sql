import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, projectsByOwner } from "./queries.js";

export async function loadAccountWorkspace(database: PostgresDatabase, accountId: bigint) {
  const [accounts, projects] = await database.batch([accountById(accountId), projectsByOwner(accountId)]);
  return { account: accounts[0], projects };
}
