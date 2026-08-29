import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { insertAccount, insertProject, type NewAccount, type NewProject } from "./mutations.js";
import { accountById } from "./queries.js";

export function createAccountWithProject(
  database: MySqlDatabase,
  account: NewAccount,
  project: Omit<NewProject, "ownerId">,
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(insertAccount(account));
    await transaction.execute(insertProject({ ...project, ownerId: account.id }));
    const insertedAccount = await transaction.one(accountById(account.id));
    return { account: insertedAccount, projectId: project.id };
  });
}
