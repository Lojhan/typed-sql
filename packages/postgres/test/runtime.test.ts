import { createHash } from "node:crypto";
import {
  type DatabaseObserver,
  type DatabaseOperationEnd,
  type DatabaseOperationStart,
  type Query,
  type QueryParameters,
  type QueryRow,
  type StandardSchemaV1,
  sql,
} from "@typed-sql/core";
import { describe, it, strict } from "poku";
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
  readonly releaseArguments: (Error | boolean | undefined)[] = [];
  releaseError: Error | undefined;
  failOnBegin = false;
  failOnCommit = false;
  failOnSelect = false;
  readonly beginError = new Error("begin failed");
  readonly commitError = new Error("commit failed");
  readonly selectError = new Error("query failed");
  blockedError: Error | undefined;
  blockedText: string | undefined;
  failOnRollback = false;
  failOnRollbackToSavepoint = false;
  failOnReleaseSavepoint = false;
  failOnSavepoint = false;
  #continueBlocked: (() => void) | undefined;
  #signalBlocked: (() => void) | undefined;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    const text = typeof config === "string" ? config : config.text;
    if (text === this.blockedText) {
      this.#signalBlocked?.();
      await new Promise<void>((resolve) => {
        this.#continueBlocked = resolve;
      });
      if (this.blockedError !== undefined) throw this.blockedError;
    }
    if (this.failOnBegin && config === "BEGIN") throw this.beginError;
    if (this.failOnCommit && config === "COMMIT") throw this.commitError;
    if (this.failOnRollback && config === "ROLLBACK") throw new Error("rollback failed");
    if (this.failOnRollbackToSavepoint && typeof config === "string" && config.startsWith("ROLLBACK TO SAVEPOINT"))
      throw new Error("savepoint rollback failed");
    if (this.failOnReleaseSavepoint && typeof config === "string" && config.startsWith("RELEASE SAVEPOINT"))
      throw new Error("savepoint release failed");
    if (this.failOnSavepoint && typeof config === "string" && config.startsWith("SAVEPOINT"))
      throw new Error("savepoint creation failed");
    if (this.failOnSelect && typeof config !== "string" && config.text.startsWith("SELECT")) throw this.selectError;
    return { rows: typeof config === "string" ? [] : [{ id: 1 }] };
  }

  waitForBlockedQuery(): Promise<void> {
    return new Promise((resolve) => {
      this.#signalBlocked = resolve;
    });
  }

  continueBlockedQuery(): void {
    this.#continueBlocked?.();
  }

  release(error?: Error | boolean): void {
    this.releaseCount += 1;
    this.releaseArguments.push(error);
    if (error instanceof Error && this.blockedText !== undefined) {
      this.blockedError = error;
      this.#continueBlocked?.();
    }
    if (this.releaseError !== undefined) throw this.releaseError;
  }

  get released(): boolean {
    return this.releaseCount > 0;
  }
}

class MockPool implements PostgresPoolLike {
  readonly executionCapabilities = { cancellation: true, deadlines: true } as const;
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
  await it("validates decoded PostgreSQL rows and retains prepared metadata", async () => {
    const schema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "test-validator",
        validate(value) {
          const row = value as { readonly id: unknown };
          return typeof row.id === "number" ? { value: { id: row.id } } : { issues: [{ message: "not number" }] };
        },
      },
    };
    const starts: DatabaseOperationStart[] = [];
    const database = createPostgresDatabase({
      pool: new MockPool(),
      observer: {
        start(operation) {
          starts.push(operation);
          return { end() {} };
        },
      },
    });
    const prepared = database.prepare("validated-account", () => sql<{ id: number }>`SELECT id FROM users`);
    const validated = sql.validateResult(prepared(), schema);
    strict.deepStrictEqual(await database.one(validated), { id: 1 });
    const start = starts[0];
    if (start?.kind !== "query") strict.fail("Expected a query observation");
    strict.strictEqual(start.prepared, true);

    const [validatedRows, ordinaryRows] = await database.batch([validated, sql<{ id: number }>`SELECT id FROM users`]);
    strict.deepStrictEqual(validatedRows, [{ id: 1 }]);
    strict.deepStrictEqual(ordinaryRows, [{ id: 1 }]);

    const [firstValidatedRows, secondValidatedRows] = await database.batch([validated, validated]);
    strict.deepStrictEqual(firstValidatedRows, [{ id: 1 }]);
    strict.deepStrictEqual(secondValidatedRows, [{ id: 1 }]);

    const invalidSchema: StandardSchemaV1<unknown, { readonly id: number }> = {
      "~standard": {
        version: 1,
        vendor: "test-validator",
        validate: () => ({ issues: [{ message: "invalid", path: ["id"] }] }),
      },
    };
    await strict.rejects(
      database.execute(sql.validateResult(sql<{ id: number }>`SELECT id FROM users`, invalidSchema)),
      /result validation failed/,
    );

    const unobserved = createPostgresDatabase({ pool: new MockPool() });
    const unobservedValidated = sql.validateResult(sql<{ id: number }>`SELECT id FROM users`, schema);
    strict.deepStrictEqual(await unobserved.execute(unobservedValidated), [{ id: 1 }]);
    strict.deepStrictEqual(await unobserved.all(unobservedValidated), [{ id: 1 }]);
    strict.deepStrictEqual(await unobserved.one(unobservedValidated), { id: 1 });
    strict.deepStrictEqual(await unobserved.maybeOne(unobservedValidated), { id: 1 });
    strict.deepStrictEqual(await unobserved.batch([unobservedValidated]), [[{ id: 1 }]]);
  });

  await it("emits redacted fingerprinted query, batch, and transaction lifecycles", async () => {
    const starts: DatabaseOperationStart[] = [];
    const ends: DatabaseOperationEnd[] = [];
    const observer: DatabaseObserver = {
      start(operation) {
        starts.push(operation);
        return { end: (completion) => ends.push(completion) };
      },
    };
    const database = createPostgresDatabase({ pool: new MockPool(), observer });
    const prepared = database.prepare("observed-account", () => sql<{ id: number }>`SELECT id FROM users`);
    const query = prepared();
    strict.deepStrictEqual(await database.one(query), { id: 1 });
    await database.batch([query]);
    await database.transaction(async (transaction) => {
      await transaction.execute(query);
      await transaction.transaction(async (nested) => nested.execute(query));
    });

    const expectedFingerprint = `sha256:${createHash("sha256")
      .update("postgres\u00001.0.0\u0000SELECT id FROM users")
      .digest("hex")}`;
    strict.deepStrictEqual(
      starts.map((operation) => operation.kind),
      ["query", "batch", "transaction", "query", "transaction", "query"],
    );
    const first = starts[0];
    if (first?.kind !== "query") strict.fail("Expected query observation");
    strict.strictEqual(first.fingerprint, expectedFingerprint);
    strict.strictEqual(first.cardinality, "one");
    strict.strictEqual(first.prepared, true);
    strict.deepStrictEqual(
      starts.slice(2).map(({ transactionDepth }) => transactionDepth),
      [1, 1, 2, 2],
    );
    for (const operation of starts) {
      strict.ok(!("text" in operation));
      strict.ok(!("values" in operation));
    }
    strict.deepStrictEqual(
      ends.map(({ status }) => status),
      ["success", "success", "success", "success", "success", "success"],
    );
    strict.strictEqual(ends[0]?.rowCount, 1);
  });

  await it("cancels transaction work by discarding the lease without attempting rollback on it", async () => {
    const pool = new MockPool();
    pool.client.blockedText = "SELECT id FROM accounts";
    const started = pool.client.waitForBlockedQuery();
    const controller = new AbortController();
    const transaction = createPostgresDatabase({ pool }).transaction(async (scope) => {
      const running = scope.all(sql<{ id: number }>`SELECT id FROM accounts`, { signal: controller.signal });
      await started;
      controller.abort();
      return running;
    });

    await strict.rejects(transaction, (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      return true;
    });
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT id FROM accounts"],
    );
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.ok(pool.client.releaseArguments[0] instanceof Error);
  });

  await it("uses policy-aware result codecs", () => {
    const defaults = createPostgresTypeParsers();
    strict.strictEqual(defaults.getTypeParser(16)("t"), true);
    strict.strictEqual(defaults.getTypeParser(23)("42"), 42);
    strict.strictEqual(defaults.getTypeParser(701)("1.25"), 1.25);
    strict.deepStrictEqual(defaults.getTypeParser(17)("\\x00ff"), new Uint8Array([0, 255]));
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
    strict.strictEqual(delegated.getTypeParser(23)("42"), 42);
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
    strict.throws(() => defaults.getTypeParser(17)("not-bytea"), /Invalid PostgreSQL bytea/);

    const extensions = createPostgresTypeParsers(undefined, undefined, native, [
      { oid: 16_384, arrayOid: 16_385, decode: (input) => String(input).slice(1, -1).split(",").map(Number) },
    ]);
    strict.deepStrictEqual(extensions.getTypeParser(16_384)("[1,2.5]"), [1, 2.5]);
    strict.deepStrictEqual(extensions.getTypeParser(16_385)('{"[1,2]",NULL}'), [[1, 2], null]);
    strict.throws(
      () => createPostgresTypeParsers(undefined, undefined, native, [{ oid: 20, decode: String }]),
      /conflicts with an existing codec/,
    );
    strict.throws(
      () => createPostgresTypeParsers(undefined, undefined, native, [{ oid: 0, decode: String }]),
      /positive safe integer/,
    );
    strict.throws(
      () => createPostgresTypeParsers(undefined, undefined, native, [{ oid: 16_384, arrayOid: 0, decode: String }]),
      /arrayOid must be a positive safe integer/,
    );
    strict.throws(
      () => createPostgresTypeParsers(undefined, undefined, native, [{ oid: 16_384, arrayOid: 1000, decode: String }]),
      /arrayOid 1000 conflicts/,
    );
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

    await db.execute(accountById(8n, false));
    const reboundCall = pool.calls[1];
    if (reboundCall === undefined || typeof reboundCall === "string")
      strict.fail("Expected a prepared query config call");
    else {
      strict.strictEqual(reboundCall.name, "account-by-id");
      strict.strictEqual(reboundCall.text, "SELECT id FROM users WHERE id = $1 AND active = $2");
      strict.deepStrictEqual(reboundCall.values, ["8", false]);
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

  await it("prepares a stable physical statement for each fragment-list cardinality", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool, preparedCardinalityVariantLimit: 2 });
    const insert = db.prepare(
      "insert-users",
      (ids: readonly number[]) => sql`INSERT INTO users (id) VALUES ${ids.map((id) => sql.fragment`(${id})`)}`,
    );

    await db.execute(insert([1]));
    await db.execute(insert([2, 3]));
    await db.execute(insert([4]));
    const calls = pool.calls as readonly PostgresQueryConfig[];
    strict.strictEqual(calls[0]?.name, "insert-users");
    strict.match(calls[1]?.name ?? "", /^tsqlv_[a-f\d]{56}$/u);
    strict.notStrictEqual(calls[1]?.name, calls[0]?.name);
    strict.strictEqual(calls[2]?.name, "insert-users");
    strict.strictEqual(calls[0]?.text, "INSERT INTO users (id) VALUES ($1)");
    strict.strictEqual(calls[1]?.text, "INSERT INTO users (id) VALUES ($1), ($2)");
    strict.deepStrictEqual(calls[1]?.values, [2, 3]);
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
    strict.deepStrictEqual(pool.client.releaseArguments, [pool.client.selectError]);
  });

  await it("refuses to commit when a transaction callback catches a query rejection", async () => {
    const pool = new MockPool();
    pool.client.failOnSelect = true;
    const db = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        db.transaction(async (transaction) => {
          await strict.rejects(() => transaction.execute(sql`SELECT id FROM users`), /query failed/);
        }),
      /query failed/,
    );

    const commands = pool.client.calls.map((call) => (typeof call === "string" ? call : call.text));
    strict.deepStrictEqual(commands, ["BEGIN", "SELECT id FROM users", "ROLLBACK"]);
    strict.strictEqual(pool.client.released, true);
    strict.deepStrictEqual(pool.client.releaseArguments, [pool.client.selectError]);
  });

  await it("blocks all later work in a failed transaction scope before driver dispatch", async () => {
    const pool = new MockPool();
    pool.client.failOnSelect = true;
    const db = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        db.transaction(async (transaction) => {
          await strict.rejects(() => transaction.execute(sql`SELECT failed`), /query failed/);
          pool.client.failOnSelect = false;

          await strict.rejects(() => transaction.execute(sql`SELECT later`), /scope cannot continue/);
          await strict.rejects(() => transaction.batch([sql`SELECT later`]), /scope cannot continue/);
          strict.throws(() => transaction.stream(sql`SELECT later`), /scope cannot continue/);
          strict.throws(() => transaction.prepare("later", () => sql`SELECT later`), /scope cannot continue/);
          await strict.rejects(() => transaction.transaction(async () => undefined), /scope cannot continue/);
        }),
      (error) => {
        strict.strictEqual(error, pool.client.selectError);
        return true;
      },
    );

    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT failed", "ROLLBACK"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [pool.client.selectError]);
  });

  await it("settles an unawaited execute before rolling back without selecting commit", async () => {
    const pool = new MockPool();
    pool.client.blockedText = "SELECT slow";
    const started = pool.client.waitForBlockedQuery();
    const db = createPostgresDatabase({ pool });
    let escapedExecute: Promise<readonly unknown[]> | undefined;

    const transaction = db.transaction(async (scope) => {
      escapedExecute = scope.execute(sql`SELECT slow`);
      void escapedExecute.catch(() => undefined);
      await started;
    });
    void transaction.catch(() => undefined);

    await started;
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT slow"],
    );
    pool.client.continueBlockedQuery();
    await escapedExecute;
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT slow", "ROLLBACK"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("preserves execute misuse while a late driver rejection marks the lease for discard", async () => {
    const pool = new MockPool();
    const timeoutError = new Error("Query read timeout");
    pool.client.blockedText = "SELECT timeout";
    pool.client.blockedError = timeoutError;
    const started = pool.client.waitForBlockedQuery();
    const db = createPostgresDatabase({ pool });
    let escapedExecute: Promise<readonly unknown[]> | undefined;

    const transaction = db.transaction(async (scope) => {
      escapedExecute = scope.execute(sql`SELECT timeout`);
      void escapedExecute.catch(() => undefined);
      await started;
    });
    void transaction.catch(() => undefined);

    await started;
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT timeout"],
    );
    pool.client.continueBlockedQuery();
    await strict.rejects(
      () => escapedExecute!,
      (error) => {
        strict.strictEqual(error, timeoutError);
        return true;
      },
    );
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT timeout", "ROLLBACK"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [timeoutError]);
  });

  await it("preserves a callback error while settling a late rejected execute before rollback", async () => {
    const pool = new MockPool();
    const queryError = new Error("late query failure");
    const callbackError = new Error("callback failed first");
    pool.client.blockedText = "SELECT late_failure";
    pool.client.blockedError = queryError;
    const started = pool.client.waitForBlockedQuery();
    const db = createPostgresDatabase({ pool });
    let escapedExecute: Promise<readonly unknown[]> | undefined;

    const transaction = db.transaction(async (scope) => {
      escapedExecute = scope.execute(sql`SELECT late_failure`);
      void escapedExecute.catch(() => undefined);
      await started;
      throw callbackError;
    });
    void transaction.catch(() => undefined);

    await started;
    pool.client.continueBlockedQuery();
    await strict.rejects(() => escapedExecute!, queryError);
    await strict.rejects(
      () => transaction,
      (error) => {
        strict.strictEqual(error, callbackError);
        return true;
      },
    );
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SELECT late_failure", "ROLLBACK"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [queryError]);
  });

  await it("rolls back an unawaited nested execute before releasing its savepoint", async () => {
    const pool = new MockPool();
    pool.client.blockedText = "SELECT nested_slow";
    const started = pool.client.waitForBlockedQuery();
    const db = createPostgresDatabase({ pool });
    let escapedExecute: Promise<readonly unknown[]> | undefined;

    const transaction = db.transaction(async (parent) => {
      await strict.rejects(
        () =>
          parent.transaction(async (nested) => {
            escapedExecute = nested.execute(sql`SELECT nested_slow`);
            void escapedExecute.catch(() => undefined);
            await started;
          }),
        /await execute before returning/,
      );
    });

    await started;
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "SELECT nested_slow"],
    );
    pool.client.continueBlockedQuery();
    await escapedExecute;
    await transaction;
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "SELECT nested_slow", "ROLLBACK TO SAVEPOINT typed_sql_2", "COMMIT"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("lets the parent finalizer settle an execute owned by an unawaited nested scope", async () => {
    const pool = new MockPool();
    pool.client.blockedText = "SELECT escaped_nested";
    const started = pool.client.waitForBlockedQuery();
    const db = createPostgresDatabase({ pool });
    let escapedExecute: Promise<readonly unknown[]> | undefined;
    let nestedTransaction: Promise<void> | undefined;

    const transaction = db.transaction(async (parent) => {
      nestedTransaction = parent.transaction(async (nested) => {
        escapedExecute = nested.execute(sql`SELECT escaped_nested`);
        void escapedExecute.catch(() => undefined);
        await started;
      });
      void nestedTransaction.catch(() => undefined);
      await started;
    });
    void transaction.catch(() => undefined);

    await started;
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "SELECT escaped_nested"],
    );
    pool.client.continueBlockedQuery();
    await escapedExecute;
    await strict.rejects(() => nestedTransaction!, /parent PostgreSQL transaction scope ended|await execute/);
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "SELECT escaped_nested", "ROLLBACK"],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("recovers the parent after savepoint rollback but still discards its lease", async () => {
    const pool = new MockPool();
    pool.client.failOnSelect = true;
    const db = createPostgresDatabase({ pool });

    await db.transaction(async (parent) => {
      await strict.rejects(
        () =>
          parent.transaction(async (nested) => {
            await strict.rejects(() => nested.execute(sql`SELECT nested_failed`), /query failed/);
            pool.client.failOnSelect = false;
            await strict.rejects(() => nested.execute(sql`SELECT nested_blocked`), /scope cannot continue/);
            await strict.rejects(() => parent.execute(sql`SELECT parent_too_early`), /until.*rolled back/);
          }),
        /query failed/,
      );
      await parent.execute(sql`SELECT parent_recovered`);
    });

    strict.deepStrictEqual(
      pool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      [
        "BEGIN",
        "SAVEPOINT typed_sql_2",
        "SELECT nested_failed",
        "ROLLBACK TO SAVEPOINT typed_sql_2",
        "SELECT parent_recovered",
        "COMMIT",
      ],
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [pool.client.selectError]);
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

  await it("keeps a successfully rolled-back callback-only failure lease reusable", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        db.transaction(async () => {
          throw new Error("callback failed");
        }),
      /callback failed/,
    );

    strict.deepStrictEqual(pool.client.calls, ["BEGIN", "ROLLBACK"]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("discards the lease when transaction control queries reject", async () => {
    const beginPool = new MockPool();
    beginPool.client.failOnBegin = true;
    let callbackCalled = false;
    await strict.rejects(
      () =>
        createPostgresDatabase({ pool: beginPool }).transaction(async () => {
          callbackCalled = true;
        }),
      (error) => {
        strict.strictEqual(error, beginPool.client.beginError);
        return true;
      },
    );
    strict.strictEqual(callbackCalled, false);
    strict.deepStrictEqual(beginPool.client.calls, ["BEGIN", "ROLLBACK"]);
    strict.deepStrictEqual(beginPool.client.releaseArguments, [beginPool.client.beginError]);

    const commitPool = new MockPool();
    commitPool.client.failOnCommit = true;
    await strict.rejects(
      () => createPostgresDatabase({ pool: commitPool }).transaction(async () => "result"),
      (error) => {
        strict.strictEqual(error, commitPool.client.commitError);
        return true;
      },
    );
    strict.deepStrictEqual(commitPool.client.calls, ["BEGIN", "COMMIT", "ROLLBACK"]);
    strict.deepStrictEqual(commitPool.client.releaseArguments, [commitPool.client.commitError]);
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
    await db.execute(sql`SELECT ${sql.value([1n, [2n]])}`);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected config");
    else strict.deepStrictEqual(call.values, [["1", ["2"]]]);
  });
});
