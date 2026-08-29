import { readFile } from "node:fs/promises";
import { QueryCancelledError } from "@typed-sql/core";
import { sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { describe, it, strict } from "poku";
import { loadAccountWorkspace } from "../src/batches.js";
import { importAccounts } from "../src/bulk.js";
import { waitUntilAborted, waitUntilDeadline } from "../src/cancellation.js";
import { findAccount, listActiveAccounts, requireAccount } from "../src/cardinality.js";
import { deleteAccount, deleteProjectsByOwner, updateAccountStatus } from "../src/mutations.js";
import { createOperationLog } from "../src/observation.js";
import { prepareAccountQueries } from "../src/prepared.js";
import { accountById, accountProjectSummary } from "../src/queries.js";
import { createAccountRouter } from "../src/routing.js";
import { collectActiveAccounts, firstActiveAccount } from "../src/streams.js";
import { createAccountWithProject } from "../src/transactions.js";
import { validatedAccountById } from "../src/validation.js";
import { connectionUri } from "../typed-sql.config.js";

const operationLog = createOperationLog();
const database = await createMySql2Database({ connectionUri, typePolicy, observer: operationLog.observer });

async function removeAccounts(ids: readonly bigint[]): Promise<void> {
  for (const id of ids) {
    await database.execute(deleteProjectsByOwner(id));
    await database.execute(deleteAccount(id));
  }
}

try {
  await describe("MySQL example against mysql2", async () => {
    await it("executes queries, cardinality, CTEs, prepared statements, batches, and streams", async () => {
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
      strict.strictEqual((await loadAccountWorkspace(database, 1n)).projects.length, 1);
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
        { id: 9_001n, email: "transaction.mysql@example.com", status: "active" },
        { id: 9_001n, name: "MySQL transaction", budget: "42.50" },
      );
      strict.deepStrictEqual(created.account, {
        id: 9_001n,
        email: "transaction.mysql@example.com",
        status: "active",
      });
      await database.execute(updateAccountStatus(9_001n, "suspended"));
      strict.deepStrictEqual(await requireAccount(database, 9_001n), {
        id: 9_001n,
        email: "transaction.mysql@example.com",
        status: "suspended",
      });
      await removeAccounts([9_001n]);
      strict.strictEqual(await findAccount(database, 9_001n), undefined);
    });

    await it("imports typed rows through LOAD DATA LOCAL INFILE", async () => {
      const ids = [9_101n, 9_102n] as const;
      await removeAccounts(ids);
      const result = await importAccounts(database, [
        { id: ids[0], email: "load-one.mysql@example.com", status: "active" },
        { id: ids[1], email: "load-two.mysql@example.com", status: "suspended" },
      ]);
      strict.strictEqual(result.rows, 2);
      strict.ok(result.bytes > 0);
      strict.deepStrictEqual(await database.one(accountById(ids[1])), {
        id: ids[1],
        email: "load-two.mysql@example.com",
        status: "suspended",
      });
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
      strict.deepStrictEqual(await database.one(sql`SELECT 1 AS value`), { value: 1n });
    });

    await it("routes proven reads with the grammar snapshot and emits redacted observations", async () => {
      const snapshot = JSON.parse(await readFile(new URL("../generated/db/schema.json", import.meta.url), "utf8"));
      const replica = await createMySql2Database({ connectionUri, typePolicy, observer: operationLog.observer });
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
