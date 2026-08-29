import { typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { connectionString } from "../typed-sql.config.js";
import { loadAccountWorkspace } from "./batches.js";
import { findAccount } from "./cardinality.js";
import { createOperationLog } from "./observation.js";
import { loadIndependentReports } from "./pipelines.js";
import { prepareAccountQueries } from "./prepared.js";
import { collectActiveAccounts } from "./streams.js";

const pgCursorPackage: string = "pg-cursor";
const pgCopyStreamsPackage: string = "pg-copy-streams";

export async function runPostgresExample() {
  const operationLog = createOperationLog();
  const database = await createPgDatabase({
    connectionString,
    typePolicy,
    observer: operationLog.observer,
    poolConfig: { pipeline: true },
    cursorImporter: () => import(pgCursorPackage),
    copyStreamsImporter: () => import(pgCopyStreamsPackage),
  });

  try {
    const prepared = prepareAccountQueries(database);
    const [account, preparedAccount, workspace, reports, streamedAccounts] = await Promise.all([
      findAccount(database, 1n),
      database.maybeOne(prepared.accountById(2n)),
      loadAccountWorkspace(database, 1n),
      loadIndependentReports(database, 1n),
      collectActiveAccounts(database),
    ]);
    return {
      account,
      preparedAccount,
      workspace,
      reports,
      streamedAccounts,
      observedOperations: operationLog.ends.length,
    };
  } finally {
    await database.close();
  }
}
