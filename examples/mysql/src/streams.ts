import type { QueryRow } from "@typed-sql/core";
import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { activeAccounts } from "./queries.js";

export function streamActiveAccounts(database: MySqlDatabase, batchSize = 100) {
  return database.stream(activeAccounts, { batchSize });
}

export async function collectActiveAccounts(database: MySqlDatabase) {
  const accounts: QueryRow<typeof activeAccounts>[] = [];
  for await (const account of streamActiveAccounts(database, 25)) accounts.push(account);
  return accounts;
}

export async function firstActiveAccount(database: MySqlDatabase) {
  for await (const account of streamActiveAccounts(database, 1)) return account;
  return undefined;
}
