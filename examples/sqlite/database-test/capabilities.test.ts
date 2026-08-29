import { typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { describe, it, strict } from "poku";
import { insertSmallAccountBatch, loadAccountWorkspace } from "../src/batches.js";
import { sqliteExecutionCapabilities } from "../src/capabilities.js";
import { findAccount, listActiveAccounts, requireAccount } from "../src/cardinality.js";
import { deleteAccount, deleteProjectsByOwner, updateAccountStatus } from "../src/mutations.js";
import { prepareAccountQueries } from "../src/prepared.js";
import { accountProjectSummary } from "../src/queries.js";
import { collectActiveAccounts, firstActiveAccount } from "../src/streams.js";
import { createAccountWithProject } from "../src/transactions.js";
import { validatedAccountById } from "../src/validation.js";
import { databasePath } from "../typed-sql.config.js";

const database = await createNodeSqliteDatabase({ path: databasePath, typePolicy });

function rowValue(row: unknown): Readonly<Record<string, unknown>> {
  if (row === null || typeof row !== "object") throw new TypeError("Expected a SQLite row object");
  return { ...row };
}

async function removeAccounts(ids: readonly bigint[]): Promise<void> {
  for (const id of ids) {
    await database.execute(deleteProjectsByOwner(id));
    await database.execute(deleteAccount(id));
  }
}

try {
  await describe("SQLite example against node:sqlite", async () => {
    await it("executes queries, cardinality, CTEs, prepared statements, batches, and streams", async () => {
      strict.strictEqual((await listActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(rowValue(await requireAccount(database, 1n)), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
      strict.strictEqual(await findAccount(database, -1n), undefined);
      strict.strictEqual((await database.all(accountProjectSummary)).length, 2);

      const prepared = prepareAccountQueries(database);
      strict.strictEqual(prepared.accountById.statementName, "example-account-by-id");
      strict.deepStrictEqual(rowValue(await database.one(prepared.accountById(2n))), {
        id: 2n,
        email: "bob@example.com",
        status: "suspended",
      });
      strict.strictEqual((await loadAccountWorkspace(database, 1n)).projects.length, 1);
      strict.strictEqual((await collectActiveAccounts(database)).length, 1);
      strict.deepStrictEqual(rowValue((await firstActiveAccount(database))!), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
        budget: 12500.5,
      });
      strict.deepStrictEqual(rowValue(await database.one(validatedAccountById(1n))), {
        id: 1n,
        email: "alice@example.com",
        status: "active",
      });
      strict.deepStrictEqual(sqliteExecutionCapabilities(database), { cancellation: false, deadlines: false });
    });

    await it("commits typed mutations atomically", async () => {
      await removeAccounts([9_001n]);
      const created = await createAccountWithProject(
        database,
        { id: 9_001n, email: "transaction.sqlite@example.com", status: "active" },
        { id: 9_001n, name: "SQLite transaction", budget: 42.5 },
      );
      strict.deepStrictEqual(rowValue(created.account), {
        id: 9_001n,
        email: "transaction.sqlite@example.com",
        status: "active",
      });
      strict.deepStrictEqual(rowValue(await database.one(updateAccountStatus(9_001n, "suspended"))), {
        id: 9_001n,
        email: "transaction.sqlite@example.com",
        status: "suspended",
      });
      await removeAccounts([9_001n]);
      strict.strictEqual(await findAccount(database, 9_001n), undefined);
    });

    await it("uses a transaction batch for small inserts without claiming a native bulk protocol", async () => {
      const ids = [9_101n, 9_102n] as const;
      await removeAccounts(ids);
      const results = await insertSmallAccountBatch(database, [
        { id: ids[0], email: "batch-one.sqlite@example.com", status: "active" },
        { id: ids[1], email: "batch-two.sqlite@example.com", status: "suspended" },
      ]);
      strict.strictEqual(results.length, 2);
      strict.deepStrictEqual(rowValue(await requireAccount(database, ids[1])), {
        id: ids[1],
        email: "batch-two.sqlite@example.com",
        status: "suspended",
      });
      await removeAccounts(ids);
    });
  });
} finally {
  await removeAccounts([9_001n, 9_101n, 9_102n]).catch(() => undefined);
  await database.close();
}
