import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, projectsByOwner } from "./queries.js";

export function prepareAccountQueries(database: PostgresDatabase) {
  return Object.freeze({
    accountById: database.prepare("example-account-by-id", accountById),
    projectsByOwner: database.prepare("example-projects-by-owner", projectsByOwner),
  });
}
