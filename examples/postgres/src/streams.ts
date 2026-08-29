import type { QueryRow } from "@typed-sql/core";
import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { activeAccounts } from "./queries.js";

export function streamActiveAccounts(database: PostgresDatabase, batchSize = 100) {
  return database.stream(activeAccounts, { batchSize });
}

export async function collectActiveAccounts(database: PostgresDatabase) {
  const accounts: QueryRow<typeof activeAccounts>[] = [];
  for await (const account of streamActiveAccounts(database, 25)) accounts.push(account);
  return accounts;
}

export async function firstActiveAccount(database: PostgresDatabase) {
  for await (const account of streamActiveAccounts(database, 1)) return account;
  return undefined;
}
