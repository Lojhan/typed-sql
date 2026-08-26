import { describe, it, strict } from "poku";
import { type Query, type QueryParameters, type QueryRow, sql } from "../../core/src/index.js";
import {
  createPostgresDatabase,
  createPostgresTypeParsers,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresPreparedQueryFactory,
  type PostgresQueryConfig,
  type PostgresQueryResult,
  type PostgresTransaction,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

class MockClient implements PostgresClientLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  releaseCount = 0;
  releaseError: Error | undefined;
  failOnSelect = false;
  failOnRollback = false;
  failOnRollbackToSavepoint = false;
  failOnReleaseSavepoint = false;
  failOnSavepoint = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    if (this.failOnRollback && config === "ROLLBACK") throw new Error("rollback failed");
    if (this.failOnRollbackToSavepoint && typeof config === "string" && config.startsWith("ROLLBACK TO SAVEPOINT"))
      throw new Error("savepoint rollback failed");
    if (this.failOnReleaseSavepoint && typeof config === "string" && config.startsWith("RELEASE SAVEPOINT"))
      throw new Error("savepoint release failed");
    if (this.failOnSavepoint && typeof config === "string" && config.startsWith("SAVEPOINT"))
      throw new Error("savepoint creation failed");
    if (this.failOnSelect && typeof config !== "string" && config.text.startsWith("SELECT"))
      throw new Error("query failed");
    return { rows: typeof config === "string" ? [] : [{ id: 1 }] };
  }

  release(): void {
    this.releaseCount += 1;
    if (this.releaseError !== undefined) throw this.releaseError;
  }

  get released(): boolean {
    return this.releaseCount > 0;
  }
}

class MockPool implements PostgresPoolLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  readonly client = new MockClient();
  ended = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    return { rows: [{ id: 1 }] };
  }

  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("PostgreSQL runtime adapter", async () => {
  await it("uses policy-aware result codecs", () => {
    const defaults = createPostgresTypeParsers();
    strict.strictEqual(defaults.getTypeParser(20)("9007199254740993"), 9007199254740993n);
    strict.strictEqual(defaults.getTypeParser(1700)("12.50"), "12.50");
    strict.deepStrictEqual(defaults.getTypeParser(1016 as Parameters<typeof defaults.getTypeParser>[0])("{1,2,NULL}"), [
      1n,
      2n,
      null,
    ]);

    const numbers = createPostgresTypeParsers({ bigint: "number", numeric: "number", date: "string", json: "string" });
    strict.strictEqual(numbers.getTypeParser(1700)("12.5"), 12.5);
    strict.throws(() => numbers.getTypeParser(20)("9007199254740993"), /safe integer range/);
    strict.throws(() => numbers.getTypeParser(1700)("Infinity"), /finite number/);

    const strings = createPostgresTypeParsers({ bigint: "string", numeric: "string", date: "string", json: "string" });
    strict.strictEqual(strings.getTypeParser(20)("42"), "42");
    strict.strictEqual(strings.getTypeParser(1082)("2026-08-24"), "2026-08-24");
    strict.strictEqual(strings.getTypeParser(114)('{"ok":true}'), '{"ok":true}');
    strict.strictEqual(strings.getTypeParser(20, "binary")("raw"), "raw");
    strict.strictEqual(strings.getTypeParser(9999)("custom"), "custom");

    const native = {
      getTypeParser(oid: number, format = "text") {
        return (input: string) => ({ format, input, oid });
      },
    };
    const delegated = createPostgresTypeParsers(undefined, undefined, native);
    strict.deepStrictEqual(delegated.getTypeParser(23)("42"), { format: "text", input: "42", oid: 23 });
    strict.deepStrictEqual(delegated.getTypeParser(17, "binary")("raw"), { format: "binary", input: "raw", oid: 17 });
    strict.strictEqual(delegated.getTypeParser(20)("42"), 42n);

    const values = createPostgresTypeParsers(
      { bigint: "bigint", numeric: "Decimal", date: "Date", json: "unknown" },
      (value) => ({ decimal: value }),
    );
    strict.deepStrictEqual(values.getTypeParser(1700)("1.25"), { decimal: "1.25" });
    strict.ok(values.getTypeParser(1082)("2026-08-24") instanceof Date);
    strict.deepStrictEqual(values.getTypeParser(3802)('{"ok":true}'), { ok: true });
    strict.deepStrictEqual(values.getTypeParser(1016)("{{1,2},{3,NULL}}"), [
      [1n, 2n],
      [3n, null],
    ]);
    strict.deepStrictEqual(values.getTypeParser(199)('{"{\\"ok\\":true}",NULL}'), [{ ok: true }, null]);
    strict.throws(
      () => createPostgresTypeParsers({ bigint: "bigint", numeric: "Decimal", date: "Date", json: "unknown" }),
      /requires a decimal/,
    );
    strict.throws(() => defaults.getTypeParser(1016)("not-an-array"), /Invalid PostgreSQL array/);
    strict.throws(() => defaults.getTypeParser(1016)("{1,2"), /Unterminated PostgreSQL array/);
  });

  await it("executes parameterized queries and encodes bigint inputs", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users WHERE id = ${7n}`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected a query config call");
    else {
      strict.deepStrictEqual(call.values, ["7"]);
      strict.ok(call.types !== undefined);
    }
    await db.close();
    strict.strictEqual(pool.ended, false);
  });

  await it("creates lazy prepared factories that retain exact query types", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    const accountById = db.prepare(
      "account-by-id",
      (id: bigint, active: boolean) =>
        sql.__typed<
          { id: number },
          readonly [bigint, boolean]
        >()`SELECT id FROM users WHERE id = ${id} AND active = ${active}`,
    );
    const exactFactory: Assert<
      Equal<
        typeof accountById,
        PostgresPreparedQueryFactory<[id: bigint, active: boolean], { id: number }, readonly [bigint, boolean]>
      >
    > = true;
    const exactRow: Assert<Equal<QueryRow<ReturnType<typeof accountById>>, { id: number }>> = true;
    const exactParameters: Assert<Equal<QueryParameters<ReturnType<typeof accountById>>, readonly [bigint, boolean]>> =
      true;
    void exactFactory;
    void exactRow;
    void exactParameters;

    strict.strictEqual(accountById.statementName, "account-by-id");
    strict.strictEqual(pool.calls.length, 0);
    strict.throws(() => {
      // @ts-expect-error Prepared factory metadata is readonly.
      accountById.statementName = "changed";
    }, /read only|Cannot assign/);

    const rows = await db.execute(accountById(7n, true));
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected a prepared query config call");
    else {
      strict.strictEqual(call.name, "account-by-id");
      strict.strictEqual(call.text, "SELECT id FROM users WHERE id = $1 AND active = $2");
      strict.deepStrictEqual(call.values, ["7", true]);
    }
  });

  await it("validates prepared names and reserves them at declaration", () => {
    const db = createPostgresDatabase({ pool: new MockPool() });
    strict.throws(() => db.prepare(null as never, () => sql`SELECT 1`), /non-empty.*NUL/);
    strict.throws(() => db.prepare("", () => sql`SELECT 1`), /non-empty.*NUL/);
    strict.throws(() => db.prepare("bad\0name", () => sql`SELECT 1`), /non-empty.*NUL/);
    db.prepare("one", () => sql`SELECT 1`);
    strict.throws(() => db.prepare("one", () => sql`SELECT 1`), /already registered/);
  });

  await it("rejects structural shape changes before driver dispatch", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    const dynamic = db.prepare(
      "dynamic-account",
      (projection: "id" | "email") =>
        sql.__typed<{ id?: number; email?: string }, readonly []>()`SELECT ${sql.raw(projection)} FROM users`,
    );

    await db.execute(dynamic("id"));
    strict.strictEqual(pool.calls.length, 1);
    strict.throws(() => dynamic("email"), /must always render the same SQL text/);
    strict.strictEqual(pool.calls.length, 1);
  });

  await it("rejects one query object carrying conflicting prepared names", () => {
    const db = createPostgresDatabase({ pool: new MockPool() });
    const shared: Query<{ id: number }, readonly []> = sql.__typed<{ id: number }, readonly []>()`SELECT id FROM users`;
    const first = db.prepare("first", () => shared);
    const second = db.prepare("second", () => shared);
    strict.strictEqual(first(), shared);
    strict.throws(() => second(), /cannot use both prepared statement "first" and "second"/);
  });

  await it("shares prepared metadata through transactions and nested transactions", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    const rootPrepared = db.prepare("root-prepared", (id: bigint) => sql`SELECT id FROM users WHERE id = ${id}`);
    let transactionPrepared: PostgresPreparedQueryFactory<[email: string], unknown, readonly [string]> | undefined;

    await db.transaction(async (transaction) => {
      await transaction.execute(rootPrepared(1n));
      transactionPrepared = transaction.prepare(
        "transaction-prepared",
        (email: string) => sql`SELECT id FROM users WHERE email = ${email}`,
      );
      await transaction.transaction(async (nested) => {
        await nested.execute(transactionPrepared!("a@example.com"));
      });
    });

    await db.execute(transactionPrepared!("b@example.com"));
    const clientQueries = pool.client.calls.filter(
      (call): call is PostgresQueryConfig => typeof call !== "string" && call.text.startsWith("SELECT"),
    );
    strict.deepStrictEqual(
      clientQueries.map((call) => call.name),
      ["root-prepared", "transaction-prepared"],
    );
    const poolQuery = pool.calls[0];
    if (poolQuery === undefined || typeof poolQuery === "string") strict.fail("Expected a prepared pool query");
    else strict.strictEqual(poolQuery.name, "transaction-prepared");
  });

  await it("treats another database instance's prepared query as ordinary", async () => {
    const firstPool = new MockPool();
    const secondPool = new MockPool();
    const firstDb = createPostgresDatabase({ pool: firstPool });
    const secondDb = createPostgresDatabase({ pool: secondPool });
    const prepared = firstDb.prepare("database-local", (id: number) => sql`SELECT id FROM users WHERE id = ${id}`);
    const query = prepared(1);

    await firstDb.execute(query);
    await secondDb.execute(query);
    const firstCall = firstPool.calls[0];
    const secondCall = secondPool.calls[0];
    if (firstCall === undefined || typeof firstCall === "string") strict.fail("Expected first query config");
    else strict.strictEqual(firstCall.name, "database-local");
    if (secondCall === undefined || typeof secondCall === "string") strict.fail("Expected second query config");
    else strict.strictEqual(secondCall.name, undefined);
  });

  await it("commits on one checked-out client and supports nested savepoints", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    await db.transaction(async (transaction) => {
      const exactTransactionScope: Assert<Equal<typeof transaction, PostgresTransaction>> = true;
      const transactionOmitsClose: Assert<Equal<Extract<keyof typeof transaction, "close">, never>> = true;
      void exactTransactionScope;
      void transactionOmitsClose;
      await transaction.execute(sql`SELECT id FROM users`);
      await transaction.transaction(async (nested) => {
        const exactNestedScope: Assert<Equal<typeof nested, PostgresTransaction>> = true;
        void exactNestedScope;
        await nested.execute(sql`SELECT id FROM users`);
      });
    });
    const commands = pool.client.calls.map((call) => (typeof call === "string" ? call : call.text));
    strict.deepStrictEqual(commands, [
      "BEGIN",
      "SELECT id FROM users",
      "SAVEPOINT typed_sql_2",
      "SELECT id FROM users",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    strict.strictEqual(pool.client.released, true);
  });

  await it("rolls back and releases the client after errors", async () => {
    const pool = new MockPool();
    pool.client.failOnSelect = true;
    const db = createPostgresDatabase({ pool });
    await strict.rejects(
      () => db.transaction(async (transaction) => transaction.execute(sql`SELECT id FROM users`)),
      /query failed/,
    );
    const commands = pool.client.calls.map((call) => (typeof call === "string" ? call : call.text));
    strict.deepStrictEqual(commands, ["BEGIN", "SELECT id FROM users", "ROLLBACK"]);
    strict.strictEqual(pool.client.released, true);
  });

  await it("preserves transaction errors when rollback and release cleanup fail", async () => {
    const pool = new MockPool();
    pool.client.failOnRollback = true;
    pool.client.releaseError = new Error("release failed");
    const db = createPostgresDatabase({ pool });
    const transactionError = new Error("transaction failed");

    await strict.rejects(
      () =>
        db.transaction(async () => {
          throw transactionError;
        }),
      (error) => {
        strict.strictEqual(error, transactionError);
        return true;
      },
    );
    strict.deepStrictEqual(pool.client.calls, ["BEGIN", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("surfaces release errors after a successful commit", async () => {
    const pool = new MockPool();
    const releaseError = new Error("release failed after commit");
    pool.client.releaseError = releaseError;
    const db = createPostgresDatabase({ pool });

    await strict.rejects(
      () => db.transaction(async () => "result"),
      (error) => {
        strict.strictEqual(error, releaseError);
        return true;
      },
    );
    strict.deepStrictEqual(pool.client.calls, ["BEGIN", "COMMIT"]);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("rolls back nested savepoints and preserves outer rollback errors", async () => {
    const nestedPool = new MockPool();
    const nestedDb = createPostgresDatabase({ pool: nestedPool });
    await strict.rejects(
      () =>
        nestedDb.transaction(async (transaction) => {
          await transaction.transaction(async () => {
            throw new Error("nested failed");
          });
        }),
      /nested failed/,
    );
    strict.deepStrictEqual(
      nestedPool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK TO SAVEPOINT typed_sql_2", "ROLLBACK"],
    );

    const rollbackPool = new MockPool();
    rollbackPool.client.failOnSelect = true;
    rollbackPool.client.failOnRollback = true;
    const rollbackDb = createPostgresDatabase({ pool: rollbackPool });
    await strict.rejects(
      () => rollbackDb.transaction(async (transaction) => transaction.execute(sql`SELECT 1`)),
      /query failed/,
    );
  });

  await it("preserves nested callback errors when savepoint rollback fails", async () => {
    const pool = new MockPool();
    pool.client.failOnRollbackToSavepoint = true;
    const db = createPostgresDatabase({ pool });
    const callbackError = new Error("nested callback failed");

    await strict.rejects(
      () =>
        db.transaction(async (transaction) => {
          await transaction.transaction(async () => {
            throw callbackError;
          });
        }),
      (error) => {
        strict.strictEqual(error, callbackError);
        return true;
      },
    );
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK TO SAVEPOINT typed_sql_2", "ROLLBACK"],
    );
    strict.strictEqual(pool.client.released, true);
  });

  await it("preserves release errors when savepoint rollback cleanup also fails", async () => {
    const pool = new MockPool();
    pool.client.failOnReleaseSavepoint = true;
    pool.client.failOnRollbackToSavepoint = true;
    const db = createPostgresDatabase({ pool });

    await strict.rejects(
      () => db.transaction(async (transaction) => transaction.transaction(async () => "result")),
      /savepoint release failed/,
    );
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      [
        "BEGIN",
        "SAVEPOINT typed_sql_2",
        "RELEASE SAVEPOINT typed_sql_2",
        "ROLLBACK TO SAVEPOINT typed_sql_2",
        "ROLLBACK",
      ],
    );
    strict.strictEqual(pool.client.released, true);
  });

  await it("does not enter a nested callback when savepoint creation fails", async () => {
    const pool = new MockPool();
    pool.client.failOnSavepoint = true;
    const db = createPostgresDatabase({ pool });
    let callbackCalled = false;

    await strict.rejects(
      () =>
        db.transaction(async (transaction) => {
          await transaction.transaction(async () => {
            callbackCalled = true;
          });
        }),
      /savepoint creation failed/,
    );
    strict.strictEqual(callbackCalled, false);
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK"],
    );
    strict.strictEqual(pool.client.released, true);
  });

  await it("owns pools when requested and prevents transactional close", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool, ownsPool: true });
    await db.transaction(async (transaction) => {
      await strict.rejects(() => (transaction as typeof db).close(), /inside a transaction/);
    });
    await db.close();
    strict.strictEqual(pool.ended, true);
  });

  await it("encodes nested bigint array parameters", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    await db.execute(sql`SELECT ${[1n, [2n]]}`);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected config");
    else strict.deepStrictEqual(call.values, [["1", ["2"]]]);
  });
});
