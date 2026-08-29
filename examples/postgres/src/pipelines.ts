import type { PostgresDatabase } from "@typed-sql/postgres/runtime";
import { accountById, accountProjectSummary } from "./queries.js";

export async function loadIndependentReports(database: PostgresDatabase, accountId: bigint) {
  const [account, summary] = await database.pipeline([accountById(accountId), accountProjectSummary]);
  return { account: account[0], summary };
}
