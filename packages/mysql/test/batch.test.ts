import { type Query, type QueryResults, sql } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import {
  createMySqlDatabase,
  type MySqlConnectionLike,
  type MySqlExecutionResult,
  type MySqlPoolLike,
  type MySqlProtocolStream,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

interface Account {
  readonly id: bigint;
  readonly email: string;
}

interface Project {
  readonly id: bigint;
  readonly budget: string | null;
}

const accountQuery = sql.__typed<Account, readonly [bigint]>()`SELECT id, email FROM accounts WHERE id >= ${1n}`;
const projectQuery = sql.__typed<Project, readonly []>()`SELECT id, budget FROM projects`;
const commandQuery = sql.__typed<never, readonly []>()`UPDATE accounts SET active = 1`;

class SingleRowStream implements MySqlProtocolStream {
  readonly fields = Promise.resolve([{ name: "id", columnType: 8 }]);
  readonly connectionReusable = true;
  closeCount = 0;
  #read = false;

  [Symbol.asyncIterator](): MySqlProtocolStream {
    return this;
  }

  async next(): Promise<IteratorResult<Record<string, unknown>>> {
    if (this.#read) return { done: true, value: undefined };
    this.#read = true;
    return { done: false, value: { id: "1" } };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class BatchConnection implements MySqlConnectionLike {
  readonly events: string[] = [];
  readonly calls: { readonly sql: string; readonly values?: readonly unknown[] }[] = [];
  releaseCount = 0;
  executeCount = 0;
  failAt: number | undefined;
  failRelease = false;
  executeHook: ((index: number) => Promise<void>) | undefined;
  readonly failure = new Error("batch query failed");
  readonly streamSource = new SingleRowStream();

  async execute(sqlText: string, values?: readonly unknown[]): Promise<MySqlExecutionResult> {
    const index = this.executeCount;
    this.executeCount += 1;
    this.calls.push({ sql: sqlText, ...(values === undefined ? {} : { values }) });
    this.events.push(`EXECUTE ${sqlText}`);
    await this.executeHook?.(index);
    if (this.failAt === index) throw this.failure;
    if (sqlText.startsWith("UPDATE")) return { rows: { affectedRows: 1 } };
    if (sqlText.includes("projects"))
      return {
        rows: [{ id: "9", budget: "12.50" }],
        fields: [
          { name: "id", columnType: 8 },
          { name: "budget", columnType: 246 },
        ],
      };
    return {
      rows: [{ id: "2", email: "alice@example.com" }],
      fields: [{ name: "id", columnType: 8 }],
    };
  }

  stream(): MySqlProtocolStream {
    this.events.push("STREAM");
    return this.streamSource;
  }

  async query(sqlText: string): Promise<MySqlExecutionResult> {
    this.events.push(sqlText);
    return { rows: [] };
  }

  async beginTransaction(): Promise<void> {
    this.events.push("BEGIN");
  }

  async commit(): Promise<void> {
    this.events.push("COMMIT");
  }

  async rollback(): Promise<void> {
    this.events.push("ROLLBACK");
  }

  release(): void {
    this.releaseCount += 1;
    this.events.push("RELEASE");
    if (this.failRelease) throw new Error("release failed");
  }
}

class BatchPool implements MySqlPoolLike {
  readonly connection = new BatchConnection();
  getConnectionCount = 0;
  poolExecuteCount = 0;

  async execute(): Promise<MySqlExecutionResult> {
    this.poolExecuteCount += 1;
    throw new Error("batch must not execute through the pool");
  }

  async getConnection(): Promise<MySqlConnectionLike> {
    this.getConnectionCount += 1;
    return this.connection;
  }

  async end(): Promise<void> {}
}

await describe("MySQL ordered batches", async () => {
  await it("preserves exact heterogeneous tuple and homogeneous array result types", async () => {
    const database = createMySqlDatabase({ pool: new BatchPool() });
    const tuple = await database.batch([accountQuery, projectQuery]);
    const exactTuple: Assert<Equal<typeof tuple, readonly [readonly Account[], readonly Project[]]>> = true;
    strict.strictEqual(exactTuple, true);

    const queries = [1n, 2n].map(
      (id): Query<Account, readonly [bigint]> =>
        sql.__typed<Account, readonly [bigint]>()`SELECT id, email FROM accounts WHERE id >= ${id}`,
    );
    const array = await database.batch(queries);
    const exactArray: Assert<Equal<typeof array, readonly (readonly Account[])[]>> = true;
    strict.strictEqual(exactArray, true);

    const invalidBatchInput = async () => {
      // @ts-expect-error batches accept only typed Query values
      await database.batch([accountQuery, "not a query"]);
    };
    void invalidBatchInput;
  });

  await it("returns one shared frozen empty tuple without acquiring a connection", async () => {
    const pool = new BatchPool();
    const result = await createMySqlDatabase({ pool }).batch([]);
    const second = await createMySqlDatabase({ pool }).batch([]);
    const exact: Assert<Equal<typeof result, readonly []>> = true;
    strict.strictEqual(exact, true);
    strict.deepStrictEqual(result, []);
    strict.strictEqual(result, second);
    strict.ok(Object.isFrozen(result));
    strict.strictEqual(pool.getConnectionCount, 0);
  });

  await it("leases one connection, executes in order, decodes rows, and supports command results", async () => {
    const pool = new BatchPool();
    const results = await createMySqlDatabase({ pool }).batch([accountQuery, projectQuery, commandQuery]);
    strict.deepStrictEqual(results, [
      [{ id: 2n, email: "alice@example.com" }],
      [{ id: 9n, budget: "12.50" }],
      [],
    ] satisfies QueryResults<[typeof accountQuery, typeof projectQuery, typeof commandQuery]>);
    strict.strictEqual(pool.getConnectionCount, 1);
    strict.strictEqual(pool.poolExecuteCount, 0);
    strict.strictEqual(pool.connection.releaseCount, 1);
    strict.deepStrictEqual(pool.connection.calls, [
      { sql: "SELECT id, email FROM accounts WHERE id >= ?", values: ["1"] },
      { sql: "SELECT id, budget FROM projects", values: [] },
      { sql: "UPDATE accounts SET active = 1", values: [] },
    ]);
    strict.ok(!pool.connection.events.includes("BEGIN"));
  });

  await it("stops at the first failure and preserves it over release cleanup", async () => {
    const pool = new BatchPool();
    pool.connection.failAt = 1;
    pool.connection.failRelease = true;
    await strict.rejects(
      () => createMySqlDatabase({ pool }).batch([accountQuery, projectQuery, commandQuery]),
      pool.connection.failure,
    );
    strict.strictEqual(pool.connection.executeCount, 2);
    strict.strictEqual(pool.connection.releaseCount, 1);
    strict.ok(!pool.connection.events.includes("BEGIN"));
  });

  await it("surfaces a release failure after a successful batch without releasing twice", async () => {
    const pool = new BatchPool();
    pool.connection.failRelease = true;
    await strict.rejects(() => createMySqlDatabase({ pool }).batch([accountQuery]), /release failed/);
    strict.strictEqual(pool.connection.executeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("reuses a transaction connection and rolls back failed transactional batches", async () => {
    const successfulPool = new BatchPool();
    const results = await createMySqlDatabase({ pool: successfulPool }).transaction((transaction) =>
      transaction.batch([accountQuery, projectQuery]),
    );
    strict.strictEqual(results[0]?.[0]?.id, 2n);
    strict.strictEqual(results[1]?.[0]?.budget, "12.50");
    strict.strictEqual(successfulPool.getConnectionCount, 1);
    strict.strictEqual(successfulPool.connection.releaseCount, 1);
    strict.deepStrictEqual(successfulPool.connection.events, [
      "BEGIN",
      "EXECUTE SELECT id, email FROM accounts WHERE id >= ?",
      "EXECUTE SELECT id, budget FROM projects",
      "COMMIT",
      "RELEASE",
    ]);

    const failedPool = new BatchPool();
    failedPool.connection.failAt = 1;
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool: failedPool }).transaction((transaction) =>
          transaction.batch([accountQuery, projectQuery, commandQuery]),
        ),
      failedPool.connection.failure,
    );
    strict.strictEqual(failedPool.connection.executeCount, 2);
    strict.ok(failedPool.connection.events.includes("ROLLBACK"));
    strict.ok(!failedPool.connection.events.includes("COMMIT"));
  });

  await it("rejects a transaction batch while a stream owns the connection", async () => {
    const pool = new BatchPool();
    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      const stream = transaction.stream(sql<{ id: bigint }>`SELECT id FROM accounts`);
      await stream.next();
      const dispatched = pool.connection.executeCount;
      await strict.rejects(() => transaction.batch([accountQuery]), /stream owns the transaction connection/);
      strict.strictEqual(pool.connection.executeCount, dispatched);
      await stream.close();
    });
  });

  await it("exclusively owns a transaction connection while executing", async () => {
    const pool = new BatchPool();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    let resumeQuery!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeQuery = resolve;
    });
    pool.connection.executeHook = async (index) => {
      if (index !== 0) return;
      queryStarted();
      await resume;
    };

    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      const batch = transaction.batch([accountQuery, projectQuery]);
      await started;
      await strict.rejects(() => transaction.execute(accountQuery), /ordered batch owns the transaction connection/);
      await strict.rejects(() => transaction.batch([projectQuery]), /ordered batch owns the transaction connection/);
      await strict.rejects(
        () => transaction.transaction(async () => undefined),
        /ordered batch owns the transaction connection/,
      );
      const stream = transaction.stream(accountQuery);
      await strict.rejects(() => stream.next(), /ordered batch owns the transaction connection/);
      strict.strictEqual(pool.connection.executeCount, 1);
      resumeQuery();
      const results = await batch;
      strict.strictEqual(results[0]?.[0]?.id, 2n);
      strict.strictEqual(results[1]?.[0]?.id, 9n);
    });
  });

  await it("snapshots the ordered query list before asynchronous work", async () => {
    const pool = new BatchPool();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    let resumeQuery!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeQuery = resolve;
    });
    pool.connection.executeHook = async (index) => {
      if (index !== 0) return;
      queryStarted();
      await resume;
    };
    const queries: (typeof accountQuery)[] = [accountQuery, accountQuery];
    const batch = createMySqlDatabase({ pool }).batch(queries);
    await started;
    queries[1] = sql.__typed<Account, readonly [bigint]>()`SELECT id, email FROM archived_accounts WHERE id >= ${2n}`;
    resumeQuery();
    await batch;
    strict.strictEqual(pool.connection.calls[1]?.sql, "SELECT id, email FROM accounts WHERE id >= ?");
  });

  await it("stops an unawaited outer transaction batch before its second query and rolls back", async () => {
    const pool = new BatchPool();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    let resumeQuery!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeQuery = resolve;
    });
    pool.connection.executeHook = async (index) => {
      if (index !== 0) return;
      queryStarted();
      await resume;
    };
    let escapedBatch!: Promise<QueryResults<readonly [typeof accountQuery, typeof projectQuery]>>;

    const transaction = createMySqlDatabase({ pool }).transaction(async (scope) => {
      escapedBatch = scope.batch([accountQuery, projectQuery]);
      void escapedBatch.catch(() => undefined);
      await started;
    });
    void transaction.catch(() => undefined);
    await started;
    await Promise.resolve();
    resumeQuery();

    await strict.rejects(() => transaction, /await the batch before returning/);
    await strict.rejects(() => escapedBatch, /scope is no longer active/);
    strict.strictEqual(pool.connection.executeCount, 1);
    strict.ok(pool.connection.events.includes("ROLLBACK"));
    strict.ok(!pool.connection.events.includes("COMMIT"));
    strict.ok(pool.connection.events.indexOf("ROLLBACK") < pool.connection.events.indexOf("RELEASE"));
  });

  await it("stops an unawaited nested batch before outer finalization releases the connection", async () => {
    const pool = new BatchPool();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    let resumeQuery!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeQuery = resolve;
    });
    pool.connection.executeHook = async (index) => {
      if (index !== 0) return;
      queryStarted();
      await resume;
    };
    let nestedWork!: Promise<void>;
    let escapedBatch!: Promise<QueryResults<readonly [typeof accountQuery, typeof projectQuery]>>;

    const outer = createMySqlDatabase({ pool }).transaction(async (transaction) => {
      nestedWork = transaction.transaction(async (nested) => {
        escapedBatch = nested.batch([accountQuery, projectQuery]);
        void escapedBatch.catch(() => undefined);
        await started;
      });
      void nestedWork.catch(() => undefined);
      await started;
    });
    void outer.catch(() => undefined);
    await started;
    await Promise.resolve();
    resumeQuery();

    await strict.rejects(() => outer, /await the batch before returning/);
    await strict.rejects(() => nestedWork, /await the batch before returning/);
    await strict.rejects(() => escapedBatch, /scope is no longer active/);
    strict.strictEqual(pool.connection.executeCount, 1);
    strict.ok(pool.connection.events.includes("ROLLBACK"));
    strict.ok(!pool.connection.events.includes("COMMIT"));
    strict.ok(!pool.connection.events.some((event) => event.startsWith("RELEASE SAVEPOINT")));
    const releaseIndex = pool.connection.events.indexOf("RELEASE");
    strict.ok(pool.connection.events.slice(releaseIndex + 1).every((event) => !event.startsWith("EXECUTE")));
  });

  await it("retains prepared rendering metadata and shared decoding", async () => {
    const pool = new BatchPool();
    const database = createMySqlDatabase({ pool });
    const source = sql<Account>`SELECT id, email FROM accounts WHERE id >= ${1n}`;
    let segmentReads = 0;
    const observed = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "segments") segmentReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const prepared = database.prepare("batch-accounts", () => observed);
    const query = prepared();
    strict.strictEqual(segmentReads, 1);
    const [rows] = await database.batch([query]);
    strict.strictEqual(segmentReads, 1);
    strict.deepStrictEqual(rows, [{ id: 2n, email: "alice@example.com" }]);
  });
});
