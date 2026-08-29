import { typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { connectionUri } from "../typed-sql.config.js";
import { loadAccountWorkspace } from "./batches.js";
import { findAccount } from "./cardinality.js";
import { createOperationLog } from "./observation.js";
import { prepareAccountQueries } from "./prepared.js";
import { accountProjectSummary } from "./queries.js";
import { collectActiveAccounts } from "./streams.js";

export async function runMySqlExample() {
  const operationLog = createOperationLog();
  const database = await createMySql2Database({ connectionUri, typePolicy, observer: operationLog.observer });

  try {
    const prepared = prepareAccountQueries(database);
    const [account, preparedAccount, workspace, summary, streamedAccounts] = await Promise.all([
      findAccount(database, 1n),
      database.maybeOne(prepared.accountById(2n)),
      loadAccountWorkspace(database, 1n),
      database.all(accountProjectSummary),
      collectActiveAccounts(database),
    ]);
    return {
      account,
      preparedAccount,
      workspace,
      summary,
      streamedAccounts,
      observedOperations: operationLog.ends.length,
    };
  } finally {
    await database.close();
  }
}
