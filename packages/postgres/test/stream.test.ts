import type { QueryStream } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresCursorLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
  type PostgresTransaction,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

class FakeCursor implements PostgresCursorLike {
  readonly reads: number[] = [];
  closeCount = 0;
  closeError: Error | undefined;
  failAtRead: number | undefined;
  readError: Error | undefined;
  readonly #pages: readonly (readonly Record<string, unknown>[])[];

  constructor(pages: readonly (readonly Record<string, unknown>[])[]) {
    this.#pages = pages;
  }

  async read(rowCount: number): Promise<readonly Record<string, unknown>[]> {
    this.reads.push(rowCount);
    if (this.failAtRead === this.reads.length) {
      this.readError = new Error(`cursor read ${this.reads.length} failed`);
      throw this.readError;
    }
    return this.#pages[this.reads.length - 1] ?? [];
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class FakeClient implements PostgresClientLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  readonly cursorConfigs: PostgresQueryConfig[] = [];
  cursor = new FakeCursor([[{ id: 1 }, { id: 2 }], []]);
  cursorOpenError: Error | undefined;
  releaseCount = 0;
  releaseErrors: (Error | boolean | undefined)[] = [];
  releaseError: Error | undefined;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    return { rows: [] };
  }

  async openCursor(config: PostgresQueryConfig): Promise<PostgresCursorLike> {
    this.cursorConfigs.push(config);
    if (this.cursorOpenError !== undefined) throw this.cursorOpenError;
    return this.cursor;
  }

  release(error?: Error | boolean): void {
    this.releaseCount += 1;
    this.releaseErrors.push(error);
    if (this.releaseError !== undefined) throw this.releaseError;
  }
}

class FakePool implements PostgresPoolLike {
  readonly client = new FakeClient();
  readonly calls: (PostgresQueryConfig | string)[] = [];
  connectCount = 0;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    return { rows: [] };
  }

  async connect(): Promise<PostgresClientLike> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {}
}

function commands(client: FakeClient): string[] {
  return client.calls.map((call) => (typeof call === "string" ? call : call.text));
}

await describe("PostgreSQL query streams", async () => {
  await it("is lazy, retains the row type, fetches bounded pages, and releases once on completion", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    const stream = database.stream(sql<{ id: number }>`SELECT id FROM account`, { batchSize: 2 });
    const exactType: Assert<Equal<typeof stream, QueryStream<{ id: number }>>> = true;
    void exactType;

    strict.strictEqual(pool.connectCount, 0);
    const rows: { id: number }[] = [];
    for await (const row of stream) rows.push(row);

    strict.deepStrictEqual(rows, [{ id: 1 }, { id: 2 }]);
    strict.strictEqual(pool.connectCount, 1);
    strict.deepStrictEqual(pool.client.cursor.reads, [2, 2]);
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
  });

  await it("validates batch sizes without acquiring a connection", () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    for (const batchSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      strict.throws(() => database.stream(sql`SELECT 1`, { batchSize }), /positive safe integer/);
    }
    strict.strictEqual(pool.connectCount, 0);
    strict.doesNotThrow(() => database.stream(sql`SELECT 1`, { batchSize: 1 }));
  });

  await it("closes before iteration, double-closes, and async-disposes without acquiring", async () => {
    const pool = new FakePool();
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await stream.close();
    await stream.close();
    await stream[Symbol.asyncDispose]();
    strict.strictEqual(pool.connectCount, 0);
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
  });

  await it("closes and releases on early for-await break", async () => {
    const pool = new FakePool();
    const stream = createPostgresDatabase({ pool }).stream(sql<{ id: number }>`SELECT id FROM account`);
    for await (const row of stream) {
      strict.strictEqual(row.id, 1);
      break;
    }
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("preserves a consumer-body error while for-await closes and releases", async () => {
    const pool = new FakePool();
    pool.client.cursor.closeError = new Error("cursor close failed");
    pool.client.releaseError = new Error("release failed");
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    const consumerError = new Error("consumer failed");
    await strict.rejects(
      async () => {
        for await (const _row of stream) throw consumerError;
      },
      (error) => {
        strict.strictEqual(error, consumerError);
        return true;
      },
    );
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("closes an active stream explicitly and releases once", async () => {
    const pool = new FakePool();
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    strict.deepStrictEqual(await stream.next(), { done: false, value: { id: 1 } });
    await stream.close();
    await stream.close();
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("preserves driver failures while closing and releasing exactly once", async () => {
    const pool = new FakePool();
    pool.client.cursor.failAtRead = 2;
    pool.client.cursor.closeError = new Error("cursor close failed");
    pool.client.releaseError = new Error("release failed");
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`, { batchSize: 1 });
    await stream.next();
    await stream.next();
    await strict.rejects(() => stream.next(), /cursor read 2 failed/);
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.strictEqual(pool.client.releaseErrors[0], pool.client.cursor.readError);
  });

  await it("preserves a driver failure before the first row", async () => {
    const pool = new FakePool();
    pool.client.cursor.failAtRead = 1;
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await strict.rejects(() => stream.next(), /cursor read 1 failed/);
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.strictEqual(pool.client.releaseErrors[0], pool.client.cursor.readError);
  });

  await it("async-disposes an active stream", async () => {
    const pool = new FakePool();
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await stream.next();
    await stream[Symbol.asyncDispose]();
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("surfaces cleanup failures after successful work and still releases", async () => {
    const pool = new FakePool();
    const closeError = new Error("cursor close failed");
    pool.client.cursor.closeError = closeError;
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await stream.next();
    await strict.rejects(
      () => stream.close(),
      (error) => {
        strict.strictEqual(error, closeError);
        return true;
      },
    );
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.strictEqual(pool.client.releaseErrors[0], closeError);
  });

  await it("surfaces a release failure when cursor cleanup succeeds", async () => {
    const pool = new FakePool();
    const releaseError = new Error("release failed");
    pool.client.releaseError = releaseError;
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await stream.next();
    await strict.rejects(
      () => stream.close(),
      (error) => {
        strict.strictEqual(error, releaseError);
        return true;
      },
    );
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
    await stream.close();
  });

  await it("releases a root lease when cursor creation fails", async () => {
    const pool = new FakePool();
    pool.client.cursorOpenError = new Error("cursor creation failed");
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    await strict.rejects(() => stream.next(), /cursor creation failed/);
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.strictEqual(pool.client.releaseErrors[0], pool.client.cursorOpenError);
  });

  await it("reports a missing optional cursor capability only when iteration starts", async () => {
    const pool = new FakePool();
    (pool.client as { openCursor: FakeClient["openCursor"] | undefined }).openCursor = undefined;
    const stream = createPostgresDatabase({ pool }).stream(sql`SELECT 1`);
    strict.strictEqual(pool.connectCount, 0);
    await strict.rejects(() => stream.next(), /pnpm add pg-cursor/);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("retains prepared metadata at the driver-neutral cursor boundary", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    const prepared = database.prepare("account-stream", (id: bigint) => sql`SELECT id FROM account WHERE id = ${id}`);
    const stream = database.stream(prepared(7n));
    await stream.next();
    const config = pool.client.cursorConfigs[0];
    strict.strictEqual(config?.name, "account-stream");
    strict.strictEqual(config?.text, "SELECT id FROM account WHERE id = $1");
    strict.deepStrictEqual(config?.values, ["7"]);
    await stream.close();
  });
});

await describe("PostgreSQL transaction query streams", async () => {
  await it("reuses the transaction client without releasing it before commit", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      const stream = transaction.stream(sql<{ id: number }>`SELECT id FROM account`);
      const exactType: Assert<Equal<typeof stream, QueryStream<{ id: number }>>> = true;
      void exactType;
      await stream.next();
      await stream.close();
      strict.strictEqual(pool.client.releaseCount, 0);
    });
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "COMMIT"]);
    strict.strictEqual(pool.connectCount, 1);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("rolls back when a transaction callback catches a cursor read failure", async () => {
    const pool = new FakePool();
    pool.client.cursor.failAtRead = 1;
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          const stream = transaction.stream(sql`SELECT streamed`);
          await strict.rejects(() => stream.next(), /cursor read 1 failed/);
        }),
      /cursor read 1 failed/,
    );

    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseCount, 1);
    strict.deepStrictEqual(pool.client.releaseErrors, [pool.client.cursor.readError]);
  });

  await it("rolls back when a transaction callback catches a cursor-open failure", async () => {
    const pool = new FakePool();
    pool.client.cursorOpenError = new Error("cursor creation failed");
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          const stream = transaction.stream(sql`SELECT streamed`);
          await strict.rejects(() => stream.next(), /cursor creation failed/);
        }),
      /cursor creation failed/,
    );

    strict.strictEqual(pool.client.cursor.closeCount, 0);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
  });

  await it("rolls back when a transaction callback catches cursor cleanup failure", async () => {
    const pool = new FakePool();
    pool.client.cursor.closeError = new Error("cursor close failed");
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          const stream = transaction.stream(sql`SELECT streamed`);
          await stream.next();
          await strict.rejects(() => stream.close(), /cursor close failed/);
        }),
      /cursor close failed/,
    );

    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
  });

  await it("allows ordinary work before an unstarted stream begins", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      const stream = transaction.stream(sql`SELECT streamed`);
      await transaction.execute(sql`SELECT buffered`);
      await stream.close();
    });
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "SELECT buffered", "COMMIT"]);
  });

  await it("rejects competing work while a transaction stream is active", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      const first = transaction.stream(sql`SELECT first`);
      const second = transaction.stream(sql`SELECT second`);
      await first.next();
      await strict.rejects(() => transaction.execute(sql`SELECT buffered`), /stream is still open/);
      await strict.rejects(() => second.next(), /stream is still open/);
      await strict.rejects(() => transaction.transaction(async () => undefined), /stream is still open/);
      strict.deepStrictEqual(commands(pool.client), ["BEGIN"]);
      await first.close();
    });
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "COMMIT"]);
  });

  await it("shares active-stream ownership across nested transaction scopes", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (parent) => {
      await parent.transaction(async (nested) => {
        const stream = nested.stream(sql`SELECT nested`);
        await stream.next();
        await strict.rejects(() => parent.execute(sql`SELECT parent`), /stream is still open/);
        strict.deepStrictEqual(commands(pool.client), ["BEGIN", "SAVEPOINT typed_sql_2"]);
        await stream.close();
      });
    });
    strict.deepStrictEqual(commands(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
  });

  await it("contains a caught nested cursor failure with its savepoint", async () => {
    const pool = new FakePool();
    pool.client.cursor.failAtRead = 1;
    const database = createPostgresDatabase({ pool });

    await database.transaction(async (parent) => {
      await strict.rejects(
        () =>
          parent.transaction(async (nested) => {
            const stream = nested.stream(sql`SELECT nested`);
            await strict.rejects(() => stream.next(), /cursor read 1 failed/);
          }),
        /cursor read 1 failed/,
      );
    });

    strict.deepStrictEqual(commands(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    strict.deepStrictEqual(pool.client.releaseErrors, [pool.client.cursor.readError]);
  });

  await it("closes an unawaited nested stream before the parent rolls back", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    let continueNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      continueNested = resolve;
    });
    let nestedStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      nestedStarted = resolve;
    });
    let nestedTransaction: Promise<void> | undefined;

    await strict.rejects(
      () =>
        database.transaction(async (parent) => {
          nestedTransaction = parent.transaction(async (nested) => {
            const stream = nested.stream(sql`SELECT nested`);
            await stream.next();
            nestedStarted();
            await nestedGate;
          });
          await started;
        }),
      /callback returned before all query streams were completed or closed/,
    );

    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK"]);
    continueNested();
    await strict.rejects(() => nestedTransaction!, /parent PostgreSQL transaction scope ended/);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK"]);
  });

  await it("closes a leaked started stream and rolls back instead of committing", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          const stream = transaction.stream(sql`SELECT streamed`);
          await stream.next();
        }),
      /callback returned before all query streams were completed or closed/,
    );
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("invalidates an escaped unstarted stream and rolls back without opening it", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    let escaped: QueryStream<unknown> | undefined;
    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          escaped = transaction.stream(sql`SELECT streamed`);
        }),
      /callback returned before all query streams were completed or closed/,
    );
    strict.strictEqual(pool.client.cursorConfigs.length, 0);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
    strict.deepStrictEqual(await escaped?.next(), { done: true, value: undefined });
  });

  await it("invalidates an escaped transaction adapter after its callback exits", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    let escaped: PostgresTransaction | undefined;
    await database.transaction(async (transaction) => {
      escaped = transaction;
    });
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "COMMIT"]);
    await strict.rejects(() => escaped!.execute(sql`SELECT escaped`), /transaction scope has ended/);
    await strict.rejects(() => escaped!.batch([sql`SELECT escaped`]), /transaction scope has ended/);
    strict.throws(() => escaped!.stream(sql`SELECT escaped`), /transaction scope has ended/);
    strict.throws(() => escaped!.prepare("escaped", () => sql`SELECT escaped`), /transaction scope has ended/);
    await strict.rejects(() => escaped!.transaction(async () => undefined), /transaction scope has ended/);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "COMMIT"]);
  });

  await it("invalidates an escaped transaction adapter after its callback fails", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    let escaped: PostgresTransaction | undefined;
    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          escaped = transaction;
          throw new Error("callback failed");
        }),
      /callback failed/,
    );
    await strict.rejects(() => escaped!.execute(sql`SELECT escaped`), /transaction scope has ended/);
    await strict.rejects(() => escaped!.batch([sql`SELECT escaped`]), /transaction scope has ended/);
    strict.throws(() => escaped!.stream(sql`SELECT escaped`), /transaction scope has ended/);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
  });

  await it("preserves a callback error while cleaning its live stream before rollback", async () => {
    const pool = new FakePool();
    pool.client.cursor.closeError = new Error("close failed");
    const database = createPostgresDatabase({ pool });
    const callbackError = new Error("callback failed");
    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          const stream = transaction.stream(sql`SELECT streamed`);
          await stream.next();
          throw callbackError;
        }),
      (error) => {
        strict.strictEqual(error, callbackError);
        return true;
      },
    );
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), ["BEGIN", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseCount, 1);
  });

  await it("cleans a nested-scope leak before rolling back its savepoint", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      await strict.rejects(
        () =>
          transaction.transaction(async (nested) => {
            nested.stream(sql`SELECT nested`);
          }),
        /callback returned before all query streams were completed or closed/,
      );
    });
    strict.deepStrictEqual(commands(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    strict.strictEqual(pool.client.cursorConfigs.length, 0);
  });

  await it("closes a started nested-scope leak before rolling back its savepoint", async () => {
    const pool = new FakePool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      await strict.rejects(
        () =>
          transaction.transaction(async (nested) => {
            const stream = nested.stream(sql`SELECT nested`);
            await stream.next();
          }),
        /callback returned before all query streams were completed or closed/,
      );
    });
    strict.strictEqual(pool.client.cursor.closeCount, 1);
    strict.deepStrictEqual(commands(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
  });
});
