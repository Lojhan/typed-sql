import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { accountById, ordersByCustomer } from "./queries.js";

export function prepareAccountQueries(database: SqliteDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    ordersByCustomer: database.prepare("example-orders-by-owner", ordersByCustomer),
  });
}
