import type { QueryRow } from "@typed-sql/core";
import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { activeAccounts } from "./queries.js";

export function streamActiveAccounts(database: SqliteDatabase, batchSize = 100) {
  return database.stream(activeAccounts, { batchSize });
}

export async function collectActiveAccounts(database: SqliteDatabase) {
  const accounts: QueryRow<typeof activeAccounts>[] = [];
  for await (const account of streamActiveAccounts(database, 25)) accounts.push(account);
  return accounts;
}

export async function firstActiveAccount(database: SqliteDatabase) {
  for await (const account of streamActiveAccounts(database, 1)) return account;
  return undefined;
}
