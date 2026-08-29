import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { insertAccount, type NewAccount } from "./mutations.js";
import { accountById, projectsByOwner } from "./queries.js";

export async function loadAccountWorkspace(database: SqliteDatabase, accountId: bigint) {
  const [accounts, projects] = await database.batch([accountById(accountId), projectsByOwner(accountId)]);
  return { account: accounts[0], projects };
}

/**
 * SQLite has no typed-sql native bulk protocol. A small batch can still share one explicit
 * transaction; large ingestion should use an application-specific native strategy.
 */
export function insertSmallAccountBatch(database: SqliteDatabase, accounts: readonly NewAccount[]) {
  return database.transaction((transaction) => transaction.batch(accounts.map(insertAccount)));
}
