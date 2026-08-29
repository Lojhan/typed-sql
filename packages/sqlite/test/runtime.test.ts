import type { PathLike } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { QueryResultValidationError, type StandardSchemaV1, sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { adaptNodeSqliteDatabase, createNodeSqliteDatabase, nodeSqlite } from "../src/node-sqlite.js";
import { createSqliteDatabase } from "../src/runtime.js";

interface Account {
  readonly id: bigint;
  readonly email: string;
}

await describe("node:sqlite runtime adapter", async () => {
  await it("normalizes file URLs for Node releases whose DatabaseSync accepts only strings", async () => {
    const paths: PathLike[] = [];
    const url = new URL("file:///tmp/typed-sql-node-sqlite.db");
    const driverImporter = async () => ({
      DatabaseSync: class {
        constructor(path: PathLike) {
          paths.push(path);
        }
        prepare(_sql: string) {
          return {
            all: () => [],
            *iterate() {},
            setReadBigInts() {},
          };
        }
        exec(_sql: string) {}
        close() {}
      },
    });
    const database = await createNodeSqliteDatabase({
      path: url,
      driverImporter,
    });
    await database.close();
    strict.deepStrictEqual(paths, [fileURLToPath(url)]);
  });

  await it("preserves stream semantics before StatementSync.iterate is available", async () => {
    const driverImporter = async () => ({
      DatabaseSync: class {
        prepare(_sql: string) {
          return {
            all: () => [{ id: 1n }, { id: 2n }],
            setReadBigInts() {},
          };
        }
        exec(_sql: string) {}
        close() {}
      },
    });
    const database = await createNodeSqliteDatabase({ path: ":memory:", driverImporter });
    const rows: { id: bigint }[] = [];
    for await (const row of database.stream(sql<{ id: bigint }>`SELECT id FROM account`)) rows.push(row);
    strict.deepStrictEqual(rows, [{ id: 1n }, { id: 2n }]);
    await database.close();
  });

  await it("validates cardinality, batch, stream, and transaction results", async () => {
    const native = new DatabaseSync(":memory:");
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT");
    native.exec("INSERT INTO account VALUES (1, 'valid@example.test'), (2, 'invalid')");
    const database = createSqliteDatabase({ connection: adaptNodeSqliteDatabase(native), ownsConnection: true });
    const schema: StandardSchemaV1<unknown, Account> = {
      "~standard": {
        version: 1,
        vendor: "test-validator",
        validate(value) {
          const row = value as Account;
          return row.email.includes("@") ? { value: row } : { issues: [{ message: "invalid", path: ["email"] }] };
        },
      },
    };
    const preparedValid = database.prepare(
      "validated-account",
      () => sql<Account>`SELECT id, email FROM account WHERE id = 1`,
    );
    const valid = sql.validateResult(preparedValid(), schema);
    const invalid = sql.validateResult(sql<Account>`SELECT id, email FROM account WHERE id = 2`, schema);

    strict.strictEqual((await database.maybeOne(valid))?.id, 1n);
    await strict.rejects(database.maybeOne(invalid), QueryResultValidationError);
    await strict.rejects(database.batch([valid, invalid]), QueryResultValidationError);
    const stream = database.stream(sql.validateResult(sql<Account>`SELECT id, email FROM account ORDER BY id`, schema));
    const first = await stream.next();
    strict.strictEqual(first.done, false);
    strict.strictEqual(first.value.id, 1n);
    strict.strictEqual(first.value.email, "valid@example.test");
    await strict.rejects(stream.next(), QueryResultValidationError);
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });

    await strict.rejects(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`INSERT INTO account VALUES (3, 'rolled-back')`);
        await transaction.one(invalid);
      }),
      QueryResultValidationError,
    );
    strict.strictEqual((await database.one(sql<{ count: bigint }>`SELECT count(*) AS count FROM account`)).count, 2n);
    await database.close();
  });

  await it("executes, prepares, batches, streams, and nests transactions", async () => {
    const native = new DatabaseSync(":memory:");
    native.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT");
    const database = createSqliteDatabase({
      connection: adaptNodeSqliteDatabase(native),
      ownsConnection: true,
    });

    await database.execute(sql`INSERT INTO account (id, email) VALUES (${1n}, ${"one@example.com"})`);
    const byId = database.prepare(
      "account-by-id",
      (id: bigint) => sql<Account>`
      SELECT id, email FROM account WHERE id = ${id}
    `,
    );
    const selected = await database.one(byId(1n));
    strict.strictEqual(selected.id, 1n);
    strict.strictEqual(selected.email, "one@example.com");

    const [first, all] = await database.batch([byId(1n), sql<Account>`SELECT id, email FROM account ORDER BY id`]);
    strict.strictEqual(first[0]?.id, 1n);
    strict.strictEqual(all.length, 1);

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`INSERT INTO account (id, email) VALUES (${2n}, ${"two@example.com"})`);
      await strict.rejects(
        transaction.transaction(async (nested) => {
          await nested.execute(sql`INSERT INTO account (id, email) VALUES (${3n}, ${"three@example.com"})`);
          throw new Error("rollback nested");
        }),
        /rollback nested/,
      );
    });

    const streamed: Account[] = [];
    for await (const row of database.stream(sql<Account>`SELECT id, email FROM account ORDER BY id`, {
      batchSize: 1,
    })) {
      streamed.push(row);
    }
    strict.deepStrictEqual(
      streamed.map(({ id }) => id),
      [1n, 2n],
    );
    strict.throws(() => database.stream(sql<Account>`SELECT id, email FROM account`, { batchSize: 0 }), /positive/);
    await database.close();
  });

  await it("reopens a real database file through the optional adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-"));
    const path = join(directory, "application.db");
    try {
      const setup = new DatabaseSync(path);
      setup.exec("CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL) STRICT");
      setup.close();

      const database = await createNodeSqliteDatabase({ path });
      await database.execute(sql`INSERT INTO account (id, email) VALUES (${7n}, ${"file@example.com"})`);
      await database.close();

      const snapshot = await nodeSqlite({ path }).introspect();
      strict.strictEqual(snapshot.tables.account?.strict, true);
      strict.strictEqual(snapshot.tables.account?.columns.id?.tsType, "bigint");

      const reopened = await createNodeSqliteDatabase({ path });
      strict.strictEqual((await reopened.one(sql<Account>`SELECT id, email FROM account`)).id, 7n);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("protects runtime row-shape and integer-decoding invariants", async () => {
    await strict.rejects(
      createNodeSqliteDatabase({ path: ":memory:", databaseOptions: { returnArrays: true } }),
      /returnArrays is owned/,
    );
    await strict.rejects(
      createNodeSqliteDatabase({ path: ":memory:", databaseOptions: { readBigInts: true } }),
      /readBigInts is owned/,
    );
    await strict.rejects(
      createNodeSqliteDatabase({ path: ":memory:", statementCacheSize: 0 }),
      /positive safe integer/,
    );
  });
});
