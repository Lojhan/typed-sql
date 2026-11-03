import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { insertAccount, type NewAccount } from "./mutations.js";
import { accountById, ordersByCustomer } from "./queries.js";

export async function loadAccountWorkspace(database: SqliteDatabase, accountId: bigint) {
  const [accounts, orders] = await database.batch([accountById(accountId), ordersByCustomer(accountId)]);
  return { account: accounts[0], orders };
}

/**
 * SQLite has no typed-sql native bulk protocol. A small batch can still share one explicit
 * transaction; large ingestion should use an application-specific native strategy.
 */
export function insertSmallAccountBatch(database: SqliteDatabase, accounts: readonly NewAccount[]) {
  return database.transaction((transaction) => transaction.batch(accounts.map(insertAccount)));
}
