import type { SqliteDatabase } from "@typed-sql/sqlite/runtime";
import { accountById, activeAccounts } from "./queries.js";

export const listActiveAccounts = (database: SqliteDatabase) => database.all(activeAccounts);

export const requireAccount = (database: SqliteDatabase, accountId: bigint) => database.one(accountById(accountId));

export const findAccount = (database: SqliteDatabase, accountId: bigint) => database.maybeOne(accountById(accountId));
