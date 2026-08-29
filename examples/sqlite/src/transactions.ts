import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { insertAccount, insertProject, type NewAccount, type NewProject } from "./mutations.js";

export function createAccountWithProject(
  database: SqliteDatabase,
  account: NewAccount,
  project: Omit<NewProject, "ownerId">,
) {
  return database.transaction(async (transaction) => {
    const insertedAccount = await transaction.one(insertAccount(account));
    const insertedProject = await transaction.one(insertProject({ ...project, ownerId: account.id }));
    return { account: insertedAccount, project: insertedProject };
  });
}
