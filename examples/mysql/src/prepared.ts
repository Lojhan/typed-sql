import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { accountById, ordersByCustomer } from "./queries.js";

export function prepareAccountQueries(database: MySqlDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    ordersByCustomer: database.prepare("example-orders-by-owner", ordersByCustomer),
  });
}
