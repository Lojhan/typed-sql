import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { accountById, projectsByOwner } from "./queries.js";

export function prepareAccountQueries(database: MySqlDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    projectsByOwner: database.prepare("example-projects-by-owner", projectsByOwner),
  });
}
