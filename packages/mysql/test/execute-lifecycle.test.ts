import { sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
  type MySqlTransaction,
} from "../src/runtime.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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
    return Promise.resolve(accountResult());
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
    throw new Error("transaction tests must use their leased connection");
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
