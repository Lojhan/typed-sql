import { readFile } from "node:fs/promises";
import { QueryCancelledError } from "@typed-sql/core";
import { postgres, sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { describe, it, strict } from "poku";
import { loadAccountWorkspace } from "../src/batches.js";
import { exportAccountsAsCsv, importAccounts } from "../src/bulk.js";
import { waitUntilAborted, waitUntilDeadline } from "../src/cancellation.js";
import { findAccount, listActiveAccounts, requireAccount } from "../src/cardinality.js";
import { deleteAccount, deleteProjectsByOwner, updateAccountStatus } from "../src/mutations.js";
import { createOperationLog } from "../src/observation.js";
import { loadIndependentReports } from "../src/pipelines.js";
import { prepareAccountQueries } from "../src/prepared.js";
import { accountById, accountProjectSummary } from "../src/queries.js";
import { createAccountRouter } from "../src/routing.js";
import { collectActiveAccounts, firstActiveAccount } from "../src/streams.js";
import { createAccountWithProject } from "../src/transactions.js";
import { validatedAccountById } from "../src/validation.js";
import { connectionString } from "../typed-sql.config.js";

const pgCursorPackage: string = "pg-cursor";
const pgCopyStreamsPackage: string = "pg-copy-streams";
const operationLog = createOperationLog();
const database = await createPgDatabase({
  connectionString,
  typePolicy,
  observer: operationLog.observer,
  poolConfig: { pipeline: true },
  cursorImporter: () => import(pgCursorPackage),
  copyStreamsImporter: () => import(pgCopyStreamsPackage),
});

async function removeAccounts(ids: readonly bigint[]): Promise<void> {
  for (const id of ids) {
    await database.execute(deleteProjectsByOwner(id));
    await database.execute(deleteAccount(id));
  }
}

try {
  await describe("PostgreSQL example against pg", async () => {
    await it("executes queries, cardinality, CTEs, prepared statements, batches, pipelines, and streams", async () => {
      strict.strictEqual((await listActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(await requireAccount(database, 1n), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
      strict.strictEqual(await findAccount(database, -1n), undefined);
      strict.strictEqual((await database.all(accountProjectSummary)).length, 2);

      const prepared = prepareAccountQueries(database);
      strict.strictEqual(prepared.accountById.statementName, "example-account-by-id");
      strict.deepStrictEqual(await database.one(prepared.accountById(2n)), {
        id: 2n,
        email: "bob@example.com",
        status: "suspended",
      });

      const workspace = await loadAccountWorkspace(database, 1n);
      strict.strictEqual(workspace.projects.length, 1);
      const reports = await loadIndependentReports(database, 1n);
      strict.strictEqual(reports.summary.length, 2);
      strict.strictEqual((await collectActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(await firstActiveAccount(database), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
        budget: "12500.50",
      });
      strict.deepStrictEqual(await database.one(validatedAccountById(1n)), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
    });

    await it("commits typed mutations atomically", async () => {
      await removeAccounts([9_001n]);
      const created = await createAccountWithProject(
        database,
        { id: 9_001n, email: "transaction.pg@example.com", status: "active" },
        { id: 9_001n, name: "PostgreSQL transaction", budget: "42.50" },
      );
      strict.deepStrictEqual(created.account, {
        id: 9_001n,
        email: "transaction.pg@example.com",
        status: "active",
      });
      strict.deepStrictEqual(await database.one(updateAccountStatus(9_001n, "suspended")), {
        id: 9_001n,
        email: "transaction.pg@example.com",
        status: "suspended",
      });
      await removeAccounts([9_001n]);
      strict.strictEqual(await findAccount(database, 9_001n), undefined);
    });

    await it("imports and exports typed rows through COPY", async () => {
      const ids = [9_101n, 9_102n] as const;
      await removeAccounts(ids);
      const result = await importAccounts(database, [
        { id: ids[0], email: "copy-one.pg@example.com", status: "active" },
        { id: ids[1], email: "copy-two.pg@example.com", status: "suspended" },
      ]);
      strict.strictEqual(result.rows, 2);
      strict.ok(result.bytes > 0);
      const chunks: Uint8Array[] = [];
      for await (const chunk of exportAccountsAsCsv(database)) chunks.push(chunk);
      const csv = new TextDecoder().decode(Buffer.concat(chunks));
      strict.match(csv, /copy-one\.pg@example\.com/u);
      strict.match(csv, /copy-two\.pg@example\.com/u);
      await removeAccounts(ids);
    });

    await it("cancels in-flight driver work by deadline and AbortSignal", async () => {
      await strict.rejects(waitUntilDeadline(database, 0.1, 10), (error) => {
        strict.ok(error instanceof QueryCancelledError);
        return true;
      });
      const controller = new AbortController();
      const pending = waitUntilAborted(database, 0.1, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await strict.rejects(pending, (error) => {
        strict.ok(error instanceof QueryCancelledError);
        return true;
      });
      strict.deepStrictEqual(await database.one(sql<{ value: number }>`SELECT 1 AS value`), { value: 1 });
    });

    await it("routes proven reads with the grammar snapshot and emits redacted observations", async () => {
      const snapshot = postgres().validateSnapshot(
        JSON.parse(await readFile(new URL("../generated/db/schema.json", import.meta.url), "utf8")),
      );
      const replica = await createPgDatabase({ connectionString, typePolicy, observer: operationLog.observer });
      try {
        const routed = createAccountRouter(database, [replica], snapshot).context();
        strict.deepStrictEqual(await routed.one(accountById(1n)), {
          id: 1n,
          email: "alice@example.com",
          status: "active",
        });
      } finally {
        await replica.close();
      }
      strict.ok(operationLog.starts.length > 0);
      strict.strictEqual(operationLog.starts.length, operationLog.ends.length);
      strict.ok(operationLog.starts.every((event) => !("text" in event) && !("values" in event)));
    });
  });
} finally {
  await removeAccounts([9_001n, 9_101n, 9_102n]).catch(() => undefined);
  await database.close();
}
