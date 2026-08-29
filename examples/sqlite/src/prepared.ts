import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { accountById, projectsByOwner } from "./queries.js";

export function prepareAccountQueries(database: SqliteDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    projectsByOwner: database.prepare("example-projects-by-owner", projectsByOwner),
  });
}
