import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, activeAccounts } from "./queries.js";

export const listActiveAccounts = (database: PostgresDatabase) => database.all(activeAccounts);

export const requireAccount = (database: PostgresDatabase, accountId: bigint) => database.one(accountById(accountId));

export const findAccount = (database: PostgresDatabase, accountId: bigint) => database.maybeOne(accountById(accountId));
