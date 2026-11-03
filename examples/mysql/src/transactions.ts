import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { insertAccount, insertOrder, type NewAccount, type NewOrder } from "./mutations.js";
import { accountById } from "./queries.js";

export function createAccountWithOrder(
  database: MySqlDatabase,
  account: NewAccount,
  purchase: Omit<NewOrder, "userId">,
) {
  return database.transaction(async (transaction) => {
    await transaction.execute(insertAccount(account));
    await transaction.execute(insertOrder({ ...purchase, userId: account.id }));
    const insertedAccount = await transaction.one(accountById(account.id));
    return { account: insertedAccount, orderId: purchase.id };
  });
}
