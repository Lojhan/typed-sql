import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, accountOrderSummary } from "./queries.js";

export async function loadIndependentReports(database: PostgresDatabase, accountId: bigint) {
  const [account, summary] = await database.pipeline([accountById(accountId), accountOrderSummary]);
  return { account: account[0], summary };
}
