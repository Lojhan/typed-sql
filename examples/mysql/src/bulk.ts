import { requireAdapterCapability } from "@typed-sql/core";
import { mysqlBulk } from "@typed-sql/mysql";
import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { bulkAccountInsert, type NewAccount } from "./mutations.js";

export function importAccounts(database: MySqlDatabase, accounts: Iterable<NewAccount> | AsyncIterable<NewAccount>) {
  const bulk = requireAdapterCapability(database, mysqlBulk);
  return bulk.loadData(bulkAccountInsert, accounts, { chunkBytes: 64 * 1024 });
}
