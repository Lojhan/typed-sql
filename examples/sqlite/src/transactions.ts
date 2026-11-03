import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { insertAccount, insertOrder, type NewAccount, type NewOrder } from "./mutations.js";

export function createAccountWithOrder(
  database: SqliteDatabase,
  account: NewAccount,
  purchase: Omit<NewOrder, "userId">,
) {
  return database.transaction(async (transaction) => {
    const insertedAccount = await transaction.one(insertAccount(account));
    const insertedOrder = await transaction.one(insertOrder({ ...purchase, userId: account.id }));
    return { account: insertedAccount, purchase: insertedOrder };
  });
}
