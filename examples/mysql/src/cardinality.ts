import type { MySqlDatabase } from "@typed-sql/mysql/runtime";
import { accountById, activeAccounts } from "./queries.js";

export const listActiveAccounts = (database: MySqlDatabase) => database.all(activeAccounts);

export const requireAccount = (database: MySqlDatabase, accountId: bigint) => database.one(accountById(accountId));

export const findAccount = (database: MySqlDatabase, accountId: bigint) => database.maybeOne(accountById(accountId));
