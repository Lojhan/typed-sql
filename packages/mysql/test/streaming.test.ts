import { type QueryStream, sql } from "@typed-sql/core";
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

interface AccountRow {
  readonly id: bigint;
  readonly active: boolean;
}

class FakeProtocolStream implements MySqlProtocolStream {
  readonly fields;
  readonly rows: readonly Record<string, unknown>[];
  connectionReusable = true;
  closeCount = 0;
  nextCount = 0;
  failAt: number | undefined;
  failClose = false;
  readonly events: string[];

  constructor(
    rows: readonly Record<string, unknown>[] = [
      { id: "9007199254740993", active: 1 },
      { id: "2", active: 0 },
    ],
    events: string[] = [],
    fields: readonly { readonly name: string; readonly columnType: number; readonly columnLength?: number }[] = [
      { name: "id", columnType: 8 },
      { name: "active", columnType: 1, columnLength: 1 },
    ],
  ) {
    this.rows = rows;
    this.events = events;
    this.fields = Promise.resolve(fields);
  }

  [Symbol.asyncIterator](): MySqlProtocolStream {
    return this;
  }

  async next(): Promise<IteratorResult<Record<string, unknown>>> {
    const index = this.nextCount;
    this.nextCount += 1;
    if (this.failAt === index) throw new Error("protocol failed");
    const value = this.rows[index];
    return value === undefined ? { done: true, value: undefined } : { done: false, value };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.events.push("STREAM CLOSE");
    if (this.failClose) throw new Error("stream close failed");
  }
}

class FakeStreamingConnection implements MySqlConnectionLike {
  readonly commands: string[] = [];
  readonly streamCalls: {
    readonly sql: string;
    readonly values: readonly unknown[];
    readonly batchSize: number;
  }[] = [];
  readonly sources: FakeProtocolStream[] = [];
  releaseCount = 0;
  executeCount = 0;
  nextSource: (() => FakeProtocolStream) | undefined;

  async execute(sqlText: string): Promise<MySqlExecutionResult> {
    this.executeCount += 1;
    this.commands.push(sqlText);
    return { rows: [] };
  }

  stream(sqlText: string, values: readonly unknown[], options: { readonly batchSize: number }): MySqlProtocolStream {
    const source = this.nextSource?.() ?? new FakeProtocolStream(undefined, this.commands);
    this.nextSource = undefined;
    this.sources.push(source);
    this.streamCalls.push({ sql: sqlText, values, batchSize: options.batchSize });
    this.commands.push(`STREAM ${sqlText}`);
    return source;
  }

  async query(sqlText: string): Promise<MySqlExecutionResult> {
    this.commands.push(sqlText);
    return { rows: [] };
  }

  async beginTransaction(): Promise<void> {
    this.commands.push("BEGIN");
  }

  async commit(): Promise<void> {
    this.commands.push("COMMIT");
  }

  async rollback(): Promise<void> {
    this.commands.push("ROLLBACK");
  }

  release(): void {
    this.releaseCount += 1;
    this.commands.push("RELEASE");
  }
}

class FakeStreamingPool implements MySqlPoolLike {
  readonly connection = new FakeStreamingConnection();
  getConnectionCount = 0;

  async execute(): Promise<MySqlExecutionResult> {
    return { rows: [] };
  }

  async getConnection(): Promise<MySqlConnectionLike> {
    this.getConnectionCount += 1;
    return this.connection;
  }

  async end(): Promise<void> {}
}

const accountsQuery = sql.__typed<AccountRow, readonly [bigint]>()`SELECT id, active FROM accounts WHERE id >= ${1n}`;

await describe("MySQL protocol streaming", async () => {
  await it("is lazy, typed, decoded, bounded, and releases a root lease after natural completion", async () => {
    const pool = new FakeStreamingPool();
    const database = createMySqlDatabase({ pool });
    const stream = database.stream(accountsQuery, { batchSize: 7 });
    const exactType: Assert<Equal<typeof stream, QueryStream<AccountRow>>> = true;
    void exactType;

    strict.strictEqual(pool.getConnectionCount, 0);
    strict.deepStrictEqual(await stream.next(), {
      done: false,
      value: { id: 9_007_199_254_740_993n, active: true },
    });
    strict.strictEqual(pool.getConnectionCount, 1);
    strict.deepStrictEqual(pool.connection.streamCalls, [
      { sql: "SELECT id, active FROM accounts WHERE id >= ?", values: ["1"], batchSize: 7 },
    ]);
    strict.deepStrictEqual(await stream.next(), { done: false, value: { id: 2n, active: false } });
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
    await stream.close();
    await stream[Symbol.asyncDispose]();
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("closes for-await early returns and explicit close without acquiring an idle stream", async () => {
    const pool = new FakeStreamingPool();
    const database = createMySqlDatabase({ pool });
    const idle = database.stream(accountsQuery);
    await idle.close();
    await idle.close();
    strict.strictEqual(pool.getConnectionCount, 0);

    const active = database.stream(accountsQuery, { batchSize: 1 });
    for await (const row of active) {
      strict.strictEqual(row.id, 9_007_199_254_740_993n);
      break;
    }
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("preserves a consumer-body failure while closing and releasing exactly once", async () => {
    const pool = new FakeStreamingPool();
    const failure = new Error("consumer failed");
    await strict.rejects(async () => {
      for await (const _row of createMySqlDatabase({ pool }).stream(accountsQuery)) throw failure;
    }, failure);
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("validates batchSize before connection acquisition", () => {
    const pool = new FakeStreamingPool();
    const database = createMySqlDatabase({ pool });
    for (const batchSize of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      strict.throws(() => database.stream(accountsQuery, { batchSize }), /positive safe integer/);
    strict.strictEqual(pool.getConnectionCount, 0);
  });

  await it("releases exactly once after protocol and decoder failures", async () => {
    const protocolPool = new FakeStreamingPool();
    protocolPool.connection.nextSource = () => {
      const source = new FakeProtocolStream();
      source.failAt = 0;
      return source;
    };
    const protocol = createMySqlDatabase({ pool: protocolPool }).stream(accountsQuery);
    await strict.rejects(() => protocol.next(), /protocol failed/);
    strict.strictEqual(protocolPool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(protocolPool.connection.releaseCount, 1);

    const decoderPool = new FakeStreamingPool();
    const decoder = createMySqlDatabase({
      pool: decoderPool,
      typePolicy: { bigint: "number", decimal: "string", date: "Date", json: "unknown", tinyint1: "boolean" },
    }).stream(accountsQuery);
    await strict.rejects(() => decoder.next(), /safe integer range/);
    strict.strictEqual(decoderPool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(decoderPool.connection.releaseCount, 1);
  });

  await it("fails an unsupported custom adapter after releasing its lease", async () => {
    const pool = new FakeStreamingPool();
    Object.defineProperty(pool.connection, "stream", { value: undefined });
    const stream = createMySqlDatabase({ pool }).stream(accountsQuery);
    await strict.rejects(() => stream.next(), /does not support protocol row streaming/);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("releases a root lease when protocol stream construction throws synchronously", async () => {
    const pool = new FakeStreamingPool();
    pool.connection.stream = () => {
      throw new Error("stream construction failed");
    };
    const stream = createMySqlDatabase({ pool }).stream(accountsQuery);
    await strict.rejects(() => stream.next(), /stream construction failed/);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("does not release a root lease that the native source marks non-reusable", async () => {
    const pool = new FakeStreamingPool();
    pool.connection.nextSource = () => {
      const source = new FakeProtocolStream();
      source.connectionReusable = false;
      return source;
    };
    const stream = createMySqlDatabase({ pool }).stream(accountsQuery);
    await stream.next();
    await stream.close();
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 0);
  });

  await it("drains command headers without exposing them as rows", async () => {
    const pool = new FakeStreamingPool();
    pool.connection.nextSource = () => new FakeProtocolStream([{ affectedRows: 1 }], [], []);
    const stream = createMySqlDatabase({ pool }).stream(sql<never>`UPDATE accounts SET active = 1`);
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
    strict.strictEqual(pool.connection.sources[0]?.nextCount, 0);
    strict.strictEqual(pool.connection.sources[0]?.closeCount, 1);
    strict.strictEqual(pool.connection.releaseCount, 1);
  });

  await it("reuses the transaction connection and commits only after a stream completes", async () => {
    const pool = new FakeStreamingPool();
    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      const rows: AccountRow[] = [];
      for await (const row of transaction.stream(accountsQuery)) rows.push(row);
      strict.strictEqual(rows.length, 2);
      strict.strictEqual(pool.connection.releaseCount, 0);
    });
    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "STREAM SELECT id, active FROM accounts WHERE id >= ?",
      "STREAM CLOSE",
      "COMMIT",
      "RELEASE",
    ]);
  });

  await it("drains an early transaction break before allowing buffered execution and commit", async () => {
    const pool = new FakeStreamingPool();
    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      for await (const _row of transaction.stream(accountsQuery)) break;
      await transaction.execute(sql`SELECT 2`);
    });
    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "STREAM SELECT id, active FROM accounts WHERE id >= ?",
      "STREAM CLOSE",
      "SELECT 2",
      "COMMIT",
      "RELEASE",
    ]);
  });

  await it("drains started streams before rollback when callbacks fail", async () => {
    const pool = new FakeStreamingPool();
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool }).transaction(async (transaction) => {
          await transaction.stream(accountsQuery).next();
          throw new Error("callback failed");
        }),
      /callback failed/,
    );
    strict.deepStrictEqual(pool.connection.commands, [
      "BEGIN",
      "STREAM SELECT id, active FROM accounts WHERE id >= ?",
      "STREAM CLOSE",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  await it("preserves callback failure when closing the active stream also fails", async () => {
    const pool = new FakeStreamingPool();
    pool.connection.nextSource = () => {
      const source = new FakeProtocolStream(undefined, pool.connection.commands);
      source.failClose = true;
      return source;
    };
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool }).transaction(async (transaction) => {
          await transaction.stream(accountsQuery).next();
          throw new Error("original callback failure");
        }),
      /original callback failure/,
    );
    strict.ok(pool.connection.commands.indexOf("STREAM CLOSE") < pool.connection.commands.indexOf("ROLLBACK"));
  });

  await it("rolls back leaked started and unstarted streams before commit", async () => {
    const startedPool = new FakeStreamingPool();
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool: startedPool }).transaction(async (transaction) => {
          await transaction.stream(accountsQuery).next();
        }),
      /returned with 1 active query stream/,
    );
    strict.ok(!startedPool.connection.commands.includes("COMMIT"));
    strict.ok(
      startedPool.connection.commands.indexOf("STREAM CLOSE") < startedPool.connection.commands.indexOf("ROLLBACK"),
    );

    const idlePool = new FakeStreamingPool();
    let escaped: QueryStream<AccountRow> | undefined;
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool: idlePool }).transaction(async (transaction) => {
          escaped = transaction.stream(accountsQuery);
        }),
      /returned with 1 active query stream/,
    );
    strict.strictEqual(idlePool.connection.streamCalls.length, 0);
    strict.deepStrictEqual(await escaped!.next(), { done: true, value: undefined });
    strict.strictEqual(idlePool.connection.streamCalls.length, 0);
  });

  await it("rejects concurrent transaction work before driver dispatch", async () => {
    const pool = new FakeStreamingPool();
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool }).transaction(async (transaction) => {
          const first = transaction.stream(accountsQuery);
          await first.next();
          await strict.rejects(() => transaction.execute(sql`SELECT 2`), /stream owns the transaction connection/);
          const second = transaction.stream(accountsQuery);
          await strict.rejects(() => second.next(), /stream owns the transaction connection/);
          await strict.rejects(
            () => transaction.transaction(async () => undefined),
            /stream owns the transaction connection/,
          );
        }),
      /returned with 1 active query stream/,
    );
    strict.strictEqual(pool.connection.executeCount, 0);
    strict.strictEqual(pool.connection.commands.filter((value) => value.startsWith("SAVEPOINT")).length, 0);
    strict.strictEqual(pool.connection.streamCalls.length, 1);
  });

  await it("shares active ownership across nested scopes and invalidates escaped transaction scopes", async () => {
    const pool = new FakeStreamingPool();
    let escapedTransaction:
      | Parameters<Parameters<ReturnType<typeof createMySqlDatabase>["transaction"]>[0]>[0]
      | undefined;
    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      await transaction.transaction(async (nested) => {
        escapedTransaction = nested;
        const stream = nested.stream(accountsQuery);
        await stream.next();
        await strict.rejects(() => transaction.execute(sql`SELECT 2`), /stream owns the transaction connection/);
        await stream.close();
      });
    });
    await strict.rejects(() => escapedTransaction!.execute(sql`SELECT 3`), /scope is no longer active/);
    await strict.rejects(() => escapedTransaction!.transaction(async () => undefined), /scope is no longer active/);
    strict.strictEqual(pool.connection.executeCount, 0);

    let escapedOuter: typeof escapedTransaction;
    await createMySqlDatabase({ pool: new FakeStreamingPool() }).transaction(async (transaction) => {
      escapedOuter = transaction;
    });
    await strict.rejects(() => escapedOuter!.execute(sql`SELECT 4`), /scope is no longer active/);
    strict.throws(() => escapedOuter!.stream(accountsQuery), /scope is no longer active/);
    strict.throws(() => escapedOuter!.prepare("late", () => sql`SELECT 1`), /scope is no longer active/);

    let failedScope: typeof escapedOuter;
    await strict.rejects(
      () =>
        createMySqlDatabase({ pool: new FakeStreamingPool() }).transaction(async (transaction) => {
          failedScope = transaction;
          throw new Error("transaction callback failed");
        }),
      /transaction callback failed/,
    );
    await strict.rejects(() => failedScope!.execute(sql`SELECT 5`), /scope is no longer active/);
  });

  await it("closes an active unawaited nested stream before outer rollback and forbids savepoint release", async () => {
    const pool = new FakeStreamingPool();
    let nestedStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nestedStarted = resolve;
    });
    let finishNested!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishNested = resolve;
    });
    let nestedWork!: Promise<void>;

    await strict.rejects(
      () =>
        createMySqlDatabase({ pool }).transaction(async (transaction) => {
          nestedWork = transaction.transaction(async (nested) => {
            await nested.stream(accountsQuery).next();
            nestedStarted();
            await finish;
          });
          await started;
        }),
      /nested query stream owned its connection/,
    );
    strict.ok(pool.connection.commands.indexOf("STREAM CLOSE") < pool.connection.commands.indexOf("ROLLBACK"));
    const finalizedCommands = [...pool.connection.commands];
    finishNested();
    await strict.rejects(() => nestedWork, /connection is no longer active/);
    strict.deepStrictEqual(pool.connection.commands, finalizedCommands);
  });

  await it("forbids an unstarted nested stream from dispatching after its outer transaction releases", async () => {
    const pool = new FakeStreamingPool();
    let nestedCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      nestedCreated = resolve;
    });
    let resumeNested!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeNested = resolve;
    });
    let nestedWork!: Promise<void>;

    await createMySqlDatabase({ pool }).transaction(async (transaction) => {
      nestedWork = transaction.transaction(async (nested) => {
        const stream = nested.stream(accountsQuery);
        nestedCreated();
        await resume;
        await stream.next();
      });
      await created;
    });

    strict.deepStrictEqual(pool.connection.commands, ["BEGIN", "SAVEPOINT typed_sql_2", "COMMIT", "RELEASE"]);
    resumeNested();
    await strict.rejects(() => nestedWork, /scope is no longer active/);
    strict.strictEqual(pool.connection.streamCalls.length, 0);
    strict.deepStrictEqual(pool.connection.commands, ["BEGIN", "SAVEPOINT typed_sql_2", "COMMIT", "RELEASE"]);
  });

  await it("reuses prepared rendering metadata for stream execution", async () => {
    const pool = new FakeStreamingPool();
    const database = createMySqlDatabase({ pool });
    const source = sql<AccountRow>`SELECT id, active FROM accounts WHERE id >= ${1n}`;
    let segmentReads = 0;
    const observed = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "segments") segmentReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const prepared = database.prepare("stream-accounts", () => observed);
    const stream = database.stream(prepared());
    strict.strictEqual(segmentReads, 1);
    await stream.next();
    strict.strictEqual(segmentReads, 1);
    await stream.close();
  });
});
