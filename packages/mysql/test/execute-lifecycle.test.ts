import { createHash } from "node:crypto";
import type { DatabaseObserver, DatabaseOperationEnd, DatabaseOperationStart, StandardSchemaV1 } from "@typed-sql/core";
import { sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { type Deferred, deferred } from "../../../test/helpers/deferred.js";
import { mySqlServerEvidence } from "../src/capabilities.js";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
  MySqlRuntimeCompatibilityError,
  type MySqlTransaction,
  MySqlWarningError,
} from "../src/runtime.js";

interface BlockedExecute {
  readonly result: Deferred<MySqlExecutionResult>;
  readonly started: Promise<void>;
  markStarted(): void;
}

function blockedExecute(): BlockedExecute {
  const started = deferred<void>();
  return { result: deferred<MySqlExecutionResult>(), started: started.promise, markStarted: () => started.resolve() };
}

const accountQuery = sql<{ id: bigint }>`SELECT id FROM accounts`;

function accountResult(id = "1"): MySqlExecutionResult {
  return { rows: [{ id }], fields: [{ name: "id", columnType: 8 }] };
}

class ExecuteConnection implements MySqlConnectionLike {
  readonly events: string[] = [];
  releaseCount = 0;
  destroyCount = 0;
  blockedText: string | undefined;
  blocked: BlockedExecute | undefined;
  serverEvidence = mySqlServerEvidence("8.4.11", {
    versionComment: "MySQL Community Server - GPL",
    sqlMode: "STRICT_TRANS_TABLES",
  });
  evidenceReads = 0;
  warningCount = 0;

  block(sqlText: string): BlockedExecute {
    const blocked = blockedExecute();
    this.blockedText = sqlText;
    this.blocked = blocked;
    return blocked;
  }

  execute(sqlText: string): Promise<MySqlExecutionResult> {
    this.events.push(`EXECUTE ${sqlText}`);
    if (sqlText === this.blockedText && this.blocked !== undefined) {
      this.blocked.markStarted();
      return this.blocked.result.promise;
    }
    return Promise.resolve({
      ...accountResult(),
      ...(this.warningCount === 0 ? {} : { warningCount: this.warningCount }),
    });
  }

  query(sqlText: string): Promise<MySqlExecutionResult> {
    this.events.push(sqlText);
    return Promise.resolve({ rows: [] });
  }

  beginTransaction(): Promise<void> {
    this.events.push("BEGIN");
    return Promise.resolve();
  }

  commit(): Promise<void> {
    this.events.push("COMMIT");
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.events.push("ROLLBACK");
    return Promise.resolve();
  }

  readServerEvidence() {
    this.evidenceReads += 1;
    return Promise.resolve(this.serverEvidence);
  }

  readWarningCount() {
    return Promise.resolve(this.warningCount);
  }

  release(): void {
    this.releaseCount += 1;
    this.events.push("RELEASE");
  }

  destroy(): void {
    this.destroyCount += 1;
    this.events.push("DESTROY");
    this.blocked?.result.reject(new Error("connection destroyed"));
  }
}

class ExecutePool implements MySqlPoolLike {
  readonly executionCapabilities = { cancellation: true, deadlines: true } as const;
  readonly connection = new ExecuteConnection();

  execute(): Promise<MySqlExecutionResult> {
    return Promise.resolve({
      ...accountResult(),
      ...(this.connection.warningCount === 0 ? {} : { warningCount: this.connection.warningCount }),
    });
  }

  getConnection(): Promise<MySqlConnectionLike> {
    return Promise.resolve(this.connection);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

await describe("MySQL transaction execute ownership", async () => {
  await it("discards failed rollback leases and preserves the callback failure even if destruction fails", async () => {
    for (const destroyFails of [false, true]) {
      const pool = new ExecutePool();
      const failure = new Error("callback failure");
      pool.connection.rollback = async () => {
        pool.connection.events.push("ROLLBACK FAILED");
        throw new Error("rollback failed");
      };
      pool.connection.destroy = () => {
        pool.connection.destroyCount += 1;
        if (destroyFails) throw new Error("destroy failed");
      };
      const database = createMySqlDatabase({ pool });
      await strict.rejects(
        database.transaction(async () => {
          throw failure;
        }),
        (error) => error === failure,
      );
      strict.strictEqual(pool.connection.releaseCount, 0);
      strict.strictEqual(pool.connection.destroyCount, 1);
    }
  });

  await it("invalidates the parent after failed savepoint recovery even if the callback catches it", async () => {
    const pool = new ExecutePool();
    const failure = new Error("nested failure");
    pool.connection.query = async (text) => {
      pool.connection.events.push(text);
      if (text.startsWith("ROLLBACK TO")) throw new Error("savepoint recovery failed");
      return { rows: [] };
    };
    const database = createMySqlDatabase({ pool });
    await strict.rejects(
      database.transaction(async (outer) => {
        await strict.rejects(
          outer.transaction(async () => {
            throw failure;
          }),
          (error) => error === failure,
        );
        await strict.rejects(outer.execute(accountQuery), /no longer active/);
      }),
      /no longer active/,
    );
    strict.strictEqual(pool.connection.destroyCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 0);
    strict.ok(!pool.connection.events.includes("COMMIT"));
    strict.ok(!pool.connection.events.includes("ROLLBACK"));
  });

  await it("rejects incompatible physical connections before application SQL dispatch", async () => {
    const pool = new ExecutePool();
    const expected = pool.connection.serverEvidence;
    const database = createMySqlDatabase({
      pool,
      compatibilitySnapshot: {
        formatVersion: 2,
        dialect: "mysql",
        dialectVersion: "1.0.0",
        server: expected,
      } as never,
    });
    strict.deepStrictEqual(await database.execute(accountQuery), [{ id: 1n }]);
    strict.strictEqual(pool.connection.evidenceReads, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);

    pool.connection.serverEvidence = mySqlServerEvidence("9.7.0", {
      versionComment: "MySQL Community Server - GPL",
      sqlMode: "STRICT_TRANS_TABLES",
    });
    await strict.rejects(
      () => database.execute(accountQuery),
      (error) => error instanceof MySqlRuntimeCompatibilityError && error.differences.includes("versionKey"),
    );
    strict.strictEqual(pool.connection.events.filter((event) => event.startsWith("EXECUTE")).length, 1);
    strict.strictEqual(pool.connection.releaseCount, 2);
    pool.connection.serverEvidence = mySqlServerEvidence("8.4.11", {
      versionComment: "MySQL Community Server - GPL",
      sqlMode: "",
    });
    await strict.rejects(
      () => database.execute(accountQuery),
      (error) => error instanceof MySqlRuntimeCompatibilityError && error.differences.includes("settings.sqlMode"),
    );
    pool.connection.serverEvidence = { ...expected, product: "mysql-compatible" };
    await strict.rejects(
      () => database.execute(accountQuery),
      (error) => error instanceof MySqlRuntimeCompatibilityError && error.differences.includes("product"),
    );
    await strict.rejects(() => database.transaction(async () => undefined), MySqlRuntimeCompatibilityError);
    strict.strictEqual(pool.connection.events.includes("BEGIN"), false);
    strict.strictEqual(pool.connection.releaseCount, 5);
  });

  await it("fails closed when compatibility is requested from an adapter without session evidence", async () => {
    const backing = new ExecuteConnection();
    const connection = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === "readServerEvidence") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    const pool: MySqlPoolLike = {
      execute: () => Promise.resolve(accountResult()),
      getConnection: () => Promise.resolve(connection),
      end: () => Promise.resolve(),
    };
    const database = createMySqlDatabase({
      pool,
      compatibilitySnapshot: {
        formatVersion: 2,
        dialect: "mysql",
        dialectVersion: "1.0.0",
        server: mySqlServerEvidence("8.4.11", "STRICT_TRANS_TABLES"),
      } as never,
    });
    await strict.rejects(
      () => database.execute(accountQuery),
      (error) =>
        error instanceof MySqlRuntimeCompatibilityError && error.differences.includes("adapter.serverEvidence"),
    );
    strict.strictEqual(backing.events.includes("EXECUTE SELECT id FROM accounts"), false);
  });

  await it("reports warnings on a redacted channel and optionally rejects them", async () => {
    const pool = new ExecutePool();
    pool.connection.warningCount = 2;
    const warnings: { readonly count: number; readonly fingerprint: string }[] = [];
    const database = createMySqlDatabase({
      pool,
      onWarning: (warning) => warnings.push(warning),
      rejectWarnings: true,
    });
    await strict.rejects(
      () => database.execute(accountQuery),
      (error) => error instanceof MySqlWarningError && error.warning.count === 2,
    );
    strict.strictEqual(warnings.length, 1);
    strict.strictEqual(warnings[0]?.count, 2);
    strict.match(warnings[0]?.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
    strict.ok(!("sql" in warnings[0]!));

    pool.connection.warningCount = 0;
    strict.deepStrictEqual(
      await createMySqlDatabase({ pool, onWarning: (warning) => warnings.push(warning) }).execute(accountQuery),
      [{ id: 1n }],
    );
    strict.strictEqual(warnings.length, 1);
  });

  await it("bounds logical prepared registrations", () => {
    const database = createMySqlDatabase({ pool: new ExecutePool(), preparedStatementLimit: 1 });
    database.prepare("first", () => sql`SELECT 1`);
    strict.throws(() => database.prepare("second", () => sql`SELECT 2`), /limit of 1 has been reached/u);
    strict.throws(
      () => createMySqlDatabase({ pool: new ExecutePool(), preparedStatementLimit: 0 }),
      /positive safe integer/u,
    );
    strict.throws(
      () => createMySqlDatabase({ pool: new ExecutePool(), decoderPlanCacheCapacity: 0 }),
      /positive safe integer/u,
    );
    strict.throws(
      () => createMySqlDatabase({ pool: new ExecutePool(), preparedStatementLimit: 1.5 }),
      /positive safe integer/u,
    );
  });

  await it("rejects malformed compatibility snapshots at construction", () => {
    const server = mySqlServerEvidence("8.4.11", "STRICT_TRANS_TABLES");
    const base = { formatVersion: 2, dialect: "mysql", dialectVersion: "1.0.0", server };
    for (const snapshot of [
      { ...base, formatVersion: 1 },
      { ...base, dialect: "postgres" },
      { ...base, server: { ...server, product: "mariadb" } },
    ]) {
      strict.throws(
        () => createMySqlDatabase({ pool: new ExecutePool(), compatibilitySnapshot: snapshot as never }),
        MySqlRuntimeCompatibilityError,
      );
    }
    strict.throws(
      () =>
        createMySqlDatabase({
          pool: new ExecutePool(),
          compatibilitySnapshot: { ...base, dialectVersion: "2.0.0" } as never,
        }),
      MySqlRuntimeCompatibilityError,
    );
    strict.throws(
      () =>
        createMySqlDatabase({
          pool: new ExecutePool(),
          compatibilitySnapshot: {
            ...base,
            server: { ...server, settings: { ...server.settings, privateSetting: "not-allowlisted" } },
          } as never,
        }),
      MySqlRuntimeCompatibilityError,
    );
  });

  await it("validates after MySQL codec decoding", async () => {
    const schema: StandardSchemaV1<unknown, { readonly id: bigint }> = {
      "~standard": {
        version: 1,
        vendor: "test-validator",
        validate(value) {
          const row = value as { readonly id: unknown };
          return typeof row.id === "bigint" ? { value: { id: row.id } } : { issues: [{ message: "not bigint" }] };
        },
      },
    };
    const database = createMySqlDatabase({ pool: new ExecutePool() });
    strict.deepStrictEqual(await database.one(sql.validateResult(accountQuery, schema)), { id: 1n });
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
    const pool = new ExecutePool();
    const database = createMySqlDatabase({ pool, observer });
    const prepared = database.prepare("observed-account", () => accountQuery);
    const query = prepared();
    strict.deepStrictEqual(await database.one(query), { id: 1n });
    await database.batch([query]);
    await database.transaction(async (transaction) => {
      await transaction.execute(query);
      await transaction.transaction(async (nested) => nested.execute(query));
    });

    const expectedFingerprint = `sha256:${createHash("sha256")
      .update("mysql\u00001.0.0\u0000SELECT id FROM accounts")
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

  await it("cancels transaction work by destroying the lease without reusing or releasing it", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");
    const controller = new AbortController();
    const transaction = createMySqlDatabase({ pool }).transaction(async (scope) => {
      const running = scope.all(accountQuery, { signal: controller.signal });
      await blocked.started;
      controller.abort();
      return running;
    });

    await strict.rejects(transaction, (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      return true;
    });
    strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts", "DESTROY"]);
    strict.strictEqual(pool.connection.destroyCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 0);
  });

  await it("owns the connection synchronously and rejects concurrent transaction work", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");

    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      const execute = transaction.execute(accountQuery);
      strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts"]);
      await blocked.started;

      await strict.rejects(
        () => transaction.execute(accountQuery),
        /execute operation owns the transaction connection/,
      );
      await strict.rejects(
        () => transaction.batch([accountQuery]),
        /execute operation owns the transaction connection/,
      );
      await strict.rejects(
        () => transaction.transaction(async () => undefined),
        /execute operation owns the transaction connection/,
      );
      const stream = transaction.stream(accountQuery);
      await strict.rejects(() => stream.next(), /execute operation owns the transaction connection/);
      strict.strictEqual(pool.connection.events.length, 2);

      blocked.result.resolve(accountResult("2"));
      strict.deepStrictEqual(await execute, [{ id: 2n }]);
    });

    strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts", "COMMIT", "RELEASE"]);
  });

  await it("settles an unawaited outer execute before reporting misuse and rolling back", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");
    let escapedExecute!: Promise<readonly { id: bigint }[]>;

    const transaction = createMySqlDatabase({ pool }).transaction(async (scope) => {
      escapedExecute = scope.execute(accountQuery);
      void escapedExecute.catch(() => undefined);
      await blocked.started;
    });
    void transaction.catch(() => undefined);
    await blocked.started;
    await nextTurn();
    strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts"]);

    blocked.result.resolve(accountResult("3"));
    strict.deepStrictEqual(await escapedExecute, [{ id: 3n }]);
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts", "ROLLBACK", "RELEASE"]);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("keeps execute misuse primary when the unawaited command rejects late", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");
    const queryError = new Error("late execute failure");
    let escapedExecute!: Promise<readonly { id: bigint }[]>;

    const transaction = createMySqlDatabase({ pool }).transaction(async (scope) => {
      escapedExecute = scope.execute(accountQuery);
      void escapedExecute.catch(() => undefined);
      await blocked.started;
    });
    void transaction.catch(() => undefined);
    await blocked.started;
    await nextTurn();
    blocked.result.reject(queryError);

    await strict.rejects(() => escapedExecute, queryError);
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(pool.connection.events, ["BEGIN", "EXECUTE SELECT id FROM accounts", "ROLLBACK", "RELEASE"]);
  });

  await it("preserves callback and awaited-query errors while settling before rollback", async () => {
    const callbackPool = new ExecutePool();
    const callbackBlocked = callbackPool.connection.block("SELECT id FROM accounts");
    const callbackError = new Error("callback failed first");
    const lateQueryError = new Error("late query failure");
    let escapedExecute!: Promise<readonly { id: bigint }[]>;

    const callbackTransaction = createMySqlDatabase({ pool: callbackPool }).transaction(async (scope) => {
      escapedExecute = scope.execute(accountQuery);
      void escapedExecute.catch(() => undefined);
      await callbackBlocked.started;
      throw callbackError;
    });
    void callbackTransaction.catch(() => undefined);
    await callbackBlocked.started;
    await nextTurn();
    strict.ok(!callbackPool.connection.events.includes("ROLLBACK"));
    callbackBlocked.result.reject(lateQueryError);
    await strict.rejects(() => escapedExecute, lateQueryError);
    await strict.rejects(() => callbackTransaction, callbackError);
    strict.deepStrictEqual(callbackPool.connection.events, [
      "BEGIN",
      "EXECUTE SELECT id FROM accounts",
      "ROLLBACK",
      "RELEASE",
    ]);

    const queryPool = new ExecutePool();
    const queryBlocked = queryPool.connection.block("SELECT id FROM accounts");
    const queryError = new Error("awaited query failure");
    const queryTransaction = createMySqlDatabase({ pool: queryPool }).transaction((scope) =>
      scope.execute(accountQuery),
    );
    void queryTransaction.catch(() => undefined);
    await queryBlocked.started;
    queryBlocked.result.reject(queryError);
    await strict.rejects(() => queryTransaction, queryError);
    strict.deepStrictEqual(queryPool.connection.events, [
      "BEGIN",
      "EXECUTE SELECT id FROM accounts",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  await it("rolls back an unawaited nested execute before releasing its savepoint", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");
    let escapedExecute!: Promise<readonly { id: bigint }[]>;

    const transaction = createMySqlDatabase({ pool }).transaction(async (parent) => {
      const nested = parent.transaction(async (scope) => {
        escapedExecute = scope.execute(accountQuery);
        void escapedExecute.catch(() => undefined);
        await blocked.started;
      });
      void nested.catch(() => undefined);
      await blocked.started;
      await nextTurn();
      strict.ok(
        !pool.connection.events.some((event) => event.includes("SAVEPOINT") && event !== "SAVEPOINT typed_sql_2"),
      );
      blocked.result.resolve(accountResult("4"));
      strict.deepStrictEqual(await escapedExecute, [{ id: 4n }]);
      await strict.rejects(() => nested, /await execute before returning/);
      await parent.execute(sql`SELECT parent_after_nested`);
    });

    await transaction;
    strict.deepStrictEqual(pool.connection.events, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "EXECUTE SELECT id FROM accounts",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "EXECUTE SELECT parent_after_nested",
      "COMMIT",
      "RELEASE",
    ]);
  });

  await it("lets the parent settle an execute owned by an unawaited nested scope before release", async () => {
    const pool = new ExecutePool();
    const blocked = pool.connection.block("SELECT id FROM accounts");
    let nestedWork!: Promise<void>;
    let escapedExecute!: Promise<readonly { id: bigint }[]>;
    let escapedNested!: MySqlTransaction;

    const transaction = createMySqlDatabase({ pool }).transaction(async (parent) => {
      nestedWork = parent.transaction(async (nested) => {
        escapedNested = nested;
        escapedExecute = nested.execute(accountQuery);
        void escapedExecute.catch(() => undefined);
        await blocked.started;
      });
      void nestedWork.catch(() => undefined);
      await blocked.started;
    });
    void transaction.catch(() => undefined);
    await blocked.started;
    await nextTurn();
    strict.deepStrictEqual(pool.connection.events, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "EXECUTE SELECT id FROM accounts",
    ]);

    blocked.result.resolve(accountResult("5"));
    strict.deepStrictEqual(await escapedExecute, [{ id: 5n }]);
    await strict.rejects(() => nestedWork, /await execute before returning/);
    await strict.rejects(() => transaction, /await execute before returning/);
    strict.deepStrictEqual(pool.connection.events, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "EXECUTE SELECT id FROM accounts",
      "ROLLBACK",
      "RELEASE",
    ]);

    const beforeEscapedDispatch = [...pool.connection.events];
    await strict.rejects(() => escapedNested.execute(sql`SELECT too_late`), /scope is no longer active/);
    strict.deepStrictEqual(pool.connection.events, beforeEscapedDispatch);
  });
});
