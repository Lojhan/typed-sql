import { typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { databasePath } from "../typed-sql.config.js";
import { loadAccountWorkspace } from "./batches.js";
import { sqliteExecutionCapabilities } from "./capabilities.js";
import { findAccount } from "./cardinality.js";
import { prepareAccountQueries } from "./prepared.js";
import { accountProjectSummary } from "./queries.js";
import { collectActiveAccounts } from "./streams.js";

export async function runSqliteExample() {
  const database = await createNodeSqliteDatabase({ path: databasePath, typePolicy });

  try {
    const prepared = prepareAccountQueries(database);
    const account = await findAccount(database, 1n);
    const preparedAccount = await database.maybeOne(prepared.accountById(2n));
    const workspace = await loadAccountWorkspace(database, 1n);
    const summary = await database.all(accountProjectSummary);
    const streamedAccounts = await collectActiveAccounts(database);
    return {
      account,
      preparedAccount,
      workspace,
      summary,
      streamedAccounts,
      executionCapabilities: sqliteExecutionCapabilities(database),
    };
  } finally {
    await database.close();
  }
}
