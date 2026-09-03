import type { PathLike } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { QueryResultValidationError, type StandardSchemaV1, sql } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import { sqliteServerEvidence } from "../src/capabilities.js";
import {
  adaptNodeSqliteDatabase,
  createNodeSqliteDatabase,
  NodeSqliteCompatibilityError,
  nodeSqlite,
} from "../src/node-sqlite.js";
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
        prepare(source: string) {
          return {
            all: () =>
              source === "SELECT sqlite_version() AS version"
                ? [{ version: "3.45.0" }]
                : source === "PRAGMA compile_options"
                  ? []
                  : [],
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
        prepare(source: string) {
          return {
            all: () =>
              source === "SELECT sqlite_version() AS version"
                ? [{ version: "3.45.0" }]
                : source === "PRAGMA compile_options"
                  ? []
                  : [{ id: 1n }, { id: 2n }],
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
    const insertAccounts = database.prepare(
      "insert-account-list",
      (accounts: readonly Account[]) =>
        sql`INSERT INTO account (id, email) VALUES ${accounts.map(
          (account) => sql.fragment`(${account.id}, ${account.email})`,
        )}`,
    );
    await database.execute(
      insertAccounts([
        { id: 4n, email: "four@example.com" },
        { id: 5n, email: "five@example.com" },
      ]),
    );
    await database.execute(insertAccounts([{ id: 6n, email: "six@example.com" }]));
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
    strict.strictEqual(all.length, 4);

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
      [1n, 2n, 4n, 5n, 6n],
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

  await it("preserves SQLite busy errors without hiding rollback or close behavior", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-sqlite-lock-"));
    const path = join(directory, "locked.db");
    const holder = new DatabaseSync(path);
    let blocked: Awaited<ReturnType<typeof createNodeSqliteDatabase>> | undefined;
    try {
      holder.exec("CREATE TABLE account (id INTEGER PRIMARY KEY) STRICT");
      holder.exec("BEGIN IMMEDIATE");
      holder.exec("INSERT INTO account VALUES (1)");
      blocked = await createNodeSqliteDatabase({ path, databaseOptions: { timeout: 0 } });
      await strict.rejects(
        blocked.execute(sql`INSERT INTO account VALUES (${2n})`),
        (error) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_SQLITE_ERROR" &&
          "errcode" in error &&
          error.errcode === 5,
      );
      holder.exec("ROLLBACK");
      await blocked.execute(sql`INSERT INTO account VALUES (${2n})`);
      strict.strictEqual((await blocked.one(sql<{ count: bigint }>`SELECT count(*) AS count FROM account`)).count, 1n);
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        // The successful path already ended the transaction.
      }
      await blocked?.close();
      holder.close();
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

  await it("validates generated snapshot evidence before execution", async () => {
    const source = new DatabaseSync(":memory:");
    const snapshot = await nodeSqlite({ database: source }).introspect();
    source.close();

    const compatible = await createNodeSqliteDatabase({
      path: ":memory:",
      snapshot: {
        ...snapshot,
        metadata: {
          generatorVersion: "test",
          schemaFormat: 2,
          schemaHash: "0".repeat(64),
          typePolicyHash: calculateTypePolicyHash({}),
        },
      },
    });
    await compatible.close();

    await strict.rejects(
      createNodeSqliteDatabase({
        path: ":memory:",
        snapshot: { ...snapshot, server: sqliteServerEvidence("3.39.0", snapshot.server.features) },
      }),
      (error) => error instanceof NodeSqliteCompatibilityError && error.reason === "version",
    );

    await strict.rejects(
      createNodeSqliteDatabase({
        path: ":memory:",
        snapshot: {
          ...snapshot,
          server: sqliteServerEvidence(
            snapshot.server.version,
            snapshot.server.features.length === 0 ? ["OMIT_JSON"] : snapshot.server.features.slice(1),
          ),
        },
      }),
      (error) => error instanceof NodeSqliteCompatibilityError && error.reason === "compile-options",
    );

    await strict.rejects(
      createNodeSqliteDatabase({
        path: ":memory:",
        typePolicy: { integer: "number", flexible: "union", unknown: "unknown" },
        snapshot: {
          ...snapshot,
          metadata: {
            generatorVersion: "test",
            schemaFormat: 2,
            schemaHash: "0".repeat(64),
            typePolicyHash: calculateTypePolicyHash({}),
          },
        },
      }),
      (error) => error instanceof NodeSqliteCompatibilityError && error.reason === "type-policy",
    );
  });

  await it("keeps runtime codecs aligned with SQLite storage classes", async () => {
    const bigintDatabase = await createNodeSqliteDatabase({ path: ":memory:" });
    const bigintRow = await bigintDatabase.one(sql<{
      integerValue: bigint;
      realValue: number;
      textValue: string;
      blobValue: Uint8Array;
      nullValue: null;
    }>`
      SELECT ${true} AS integerValue, 1.5 AS realValue, json('{"ok":true}') AS textValue,
             ${new Uint8Array([1, 2, 3])} AS blobValue, NULL AS nullValue
    `);
    strict.strictEqual(bigintRow.integerValue, 1n);
    strict.strictEqual(bigintRow.realValue, 1.5);
    strict.strictEqual(bigintRow.textValue, '{"ok":true}');
    strict.deepStrictEqual(bigintRow.blobValue, new Uint8Array([1, 2, 3]));
    strict.strictEqual(bigintRow.nullValue, null);
    await bigintDatabase.close();

    const numberDatabase = await createNodeSqliteDatabase({
      path: ":memory:",
      typePolicy: { integer: "number", flexible: "union", unknown: "unknown" },
    });
    strict.strictEqual((await numberDatabase.one(sql<{ value: number }>`SELECT ${true} AS value`)).value, 1);
    await numberDatabase.close();
  });
});
