import { requireAdapterCapability } from "@typed-sql/core";
import { postgresCopy, sql } from "@typed-sql/postgres";
import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { bulkAccountInsert, type NewAccount } from "./mutations.js";

export function importAccounts(database: PostgresDatabase, accounts: Iterable<NewAccount> | AsyncIterable<NewAccount>) {
  const copy = requireAdapterCapability(database, postgresCopy);
  return copy.copyFrom(bulkAccountInsert, accounts, { chunkBytes: 64 * 1024 });
}

export function exportAccountsAsCsv(database: PostgresDatabase) {
  const copy = requireAdapterCapability(database, postgresCopy);
  return copy.copyTo(sql`
    SELECT id, email, status
    FROM users
    ORDER BY id
  `);
}
