import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, ordersByCustomer } from "./queries.js";

export function prepareAccountQueries(database: PostgresDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    ordersByCustomer: database.prepare("example-orders-by-owner", ordersByCustomer),
  });
}
