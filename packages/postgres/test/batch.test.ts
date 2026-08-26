import type { Query, QueryResults } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresCursorLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

class BatchCursor implements PostgresCursorLike {
  closeCount = 0;

  async read(): Promise<readonly Record<string, unknown>[]> {
    return [{ id: 1 }];
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class BatchClient implements PostgresClientLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  readonly releaseArguments: (Error | boolean | undefined)[] = [];
  readonly rows = new Map<string, readonly Record<string, unknown>[]>();
  readonly cursor = new BatchCursor();
  failText: string | undefined;
  releaseError: Error | undefined;
  blockedText: string | undefined;
  readonly #startedResolvers: (() => void)[] = [];
  readonly #continueResolvers: (() => void)[] = [];

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    const text = typeof config === "string" ? config : config.text;
    if (text === this.blockedText) {
      await new Promise<void>((resolve) => {
        this.#startedResolvers.shift()?.();
        this.#continueResolvers.push(resolve);
      });
    }
    if (text === this.failText) throw new Error(`failed: ${text}`);
    return { rows: this.rows.get(text) ?? [] };
  }

  async openCursor(): Promise<PostgresCursorLike> {
    return this.cursor;
  }

  waitForBlockedQuery(): Promise<void> {
    return new Promise((resolve) => this.#startedResolvers.push(resolve));
  }

  continueBlockedQuery(): void {
    this.#continueResolvers.shift()?.();
  }

  release(error?: Error | boolean): void {
    this.releaseArguments.push(error);
    if (this.releaseError !== undefined) throw this.releaseError;
  }
}

class BatchPool implements PostgresPoolLike {
  readonly client = new BatchClient();
  connectCount = 0;
  directQueryCount = 0;
  blockConnect = false;
  #connectStarted: (() => void) | undefined;
  #continueConnect: (() => void) | undefined;

  async query(): Promise<PostgresQueryResult> {
    this.directQueryCount += 1;
    return { rows: [] };
  }

  async connect(): Promise<PostgresClientLike> {
    this.connectCount += 1;
    if (this.blockConnect) {
      this.#connectStarted?.();
      await new Promise<void>((resolve) => {
        this.#continueConnect = resolve;
      });
    }
    return this.client;
  }

  waitForConnect(): Promise<void> {
    return new Promise((resolve) => {
      this.#connectStarted = resolve;
    });
  }

  continueConnect(): void {
    this.#continueConnect?.();
  }

  async end(): Promise<void> {}
}

function commandText(client: BatchClient): string[] {
  return client.calls.map((call) => (typeof call === "string" ? call : call.text));
}

const accountQuery = sql<{ id: bigint; email: string }>`SELECT id, email FROM account`;
const projectQuery = sql<{ id: bigint; budget: string | null }>`SELECT id, budget FROM project`;

await describe("PostgreSQL ordered query batches", async () => {
  await it("preserves heterogeneous tuples, homogeneous arrays, and rejects non-query members", async () => {
    const database = createPostgresDatabase({ pool: new BatchPool() });
    const tuple = database.batch([accountQuery, projectQuery]);
    const exactTuple: Assert<
      Equal<
        Awaited<typeof tuple>,
        readonly [readonly { id: bigint; email: string }[], readonly { id: bigint; budget: string | null }[]]
      >
    > = true;
    const queries = [1n, 2n].map(
      (id): Query<{ id: bigint }, readonly [bigint]> => sql`SELECT id FROM account WHERE id = ${id}`,
    );
    const array = database.batch(queries);
    const exactArray: Assert<Equal<Awaited<typeof array>, readonly (readonly { id: bigint }[])[]>> = true;
    const mapper: Assert<
      Equal<
        QueryResults<readonly [typeof accountQuery, typeof projectQuery]>,
        readonly [readonly { id: bigint; email: string }[], readonly { id: bigint; budget: string | null }[]]
      >
    > = true;
    void exactTuple;
    void exactArray;
    void mapper;
    await tuple;
    await array;

    const rejectNonQueryMember = (): Promise<unknown> => {
      // @ts-expect-error Every batch member must be a typed Query.
      return database.batch([accountQuery, "SELECT 1"]);
    };
    void rejectNonQueryMember;
  });

  await it("returns one shared frozen empty result without acquiring a connection", async () => {
    const pool = new BatchPool();
    const database = createPostgresDatabase({ pool });
    const empty = database.batch([]);
    const exactEmpty: Assert<Equal<Awaited<typeof empty>, readonly []>> = true;
    void exactEmpty;
    const first = await empty;
    const second = await database.batch([]);
    strict.deepStrictEqual(first, []);
    strict.strictEqual(first, second);
    strict.ok(Object.isFrozen(first));
    strict.strictEqual(pool.connectCount, 0);
    strict.strictEqual(pool.directQueryCount, 0);
  });

  await it("leases one client and executes every query sequentially in input order", async () => {
    const pool = new BatchPool();
    pool.client.rows.set("SELECT id, email FROM account", [{ id: 1n, email: "one@example.com" }]);
    pool.client.rows.set("SELECT id, budget FROM project", [{ id: 2n, budget: "12.50" }]);
    const database = createPostgresDatabase({ pool });

    const results = await database.batch([accountQuery, projectQuery]);

    strict.deepStrictEqual(results, [[{ id: 1n, email: "one@example.com" }], [{ id: 2n, budget: "12.50" }]]);
    strict.deepStrictEqual(commandText(pool.client), [
      "SELECT id, email FROM account",
      "SELECT id, budget FROM project",
    ]);
    strict.strictEqual(pool.connectCount, 1);
    strict.strictEqual(pool.directQueryCount, 0);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("snapshots the ordered input before waiting for a root connection", async () => {
    const pool = new BatchPool();
    pool.blockConnect = true;
    const connectStarted = pool.waitForConnect();
    const queries: Query<unknown, readonly []>[] = [sql`SELECT first`];
    const results = createPostgresDatabase({ pool }).batch(queries);
    await connectStarted;
    queries.push(sql`SELECT appended too late`);
    pool.continueConnect();

    await results;
    strict.deepStrictEqual(commandText(pool.client), ["SELECT first"]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("retains parameter codecs and prepared metadata for each entry", async () => {
    const pool = new BatchPool();
    const database = createPostgresDatabase({ pool });
    const byId = database.prepare("batch-account-by-id", (id: bigint) => sql`SELECT id FROM account WHERE id = ${id}`);

    await database.batch([byId(7n), sql`SELECT id FROM project WHERE owner_id = ${7n}`]);

    const [prepared, ordinary] = pool.client.calls;
    if (prepared === undefined || typeof prepared === "string") strict.fail("Expected a prepared query config");
    if (ordinary === undefined || typeof ordinary === "string") strict.fail("Expected an ordinary query config");
    strict.strictEqual(prepared.name, "batch-account-by-id");
    strict.deepStrictEqual(prepared.values, ["7"]);
    strict.strictEqual(ordinary.name, undefined);
    strict.deepStrictEqual(ordinary.values, ["7"]);
    strict.ok(prepared.types !== undefined);
    strict.strictEqual(prepared.types, ordinary.types);
  });

  await it("stops at the first failure, releases once, and preserves that failure over cleanup", async () => {
    const pool = new BatchPool();
    pool.client.failText = "SELECT broken";
    pool.client.releaseError = new Error("release failed");
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () => database.batch([sql`SELECT first`, sql`SELECT broken`, sql`SELECT never`]),
      (error) => {
        strict.match((error as Error).message, /failed: SELECT broken/);
        return true;
      },
    );

    strict.deepStrictEqual(commandText(pool.client), ["SELECT first", "SELECT broken"]);
    strict.strictEqual(pool.connectCount, 1);
    strict.strictEqual(pool.client.releaseArguments.length, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("surfaces a release failure after a successful batch without releasing twice", async () => {
    const pool = new BatchPool();
    const releaseError = new Error("release failed");
    pool.client.releaseError = releaseError;
    await strict.rejects(
      () => createPostgresDatabase({ pool }).batch([sql`SELECT one`]),
      (error) => {
        strict.strictEqual(error, releaseError);
        return true;
      },
    );
    strict.strictEqual(pool.client.releaseArguments.length, 1);
  });
});

await describe("PostgreSQL transaction query batches", async () => {
  await it("reuses the transaction client and gains atomicity only from the surrounding transaction", async () => {
    const pool = new BatchPool();
    pool.client.rows.set("SELECT first", [{ value: "first" }]);
    pool.client.rows.set("SELECT second", [{ value: "second" }]);
    const database = createPostgresDatabase({ pool });

    const results = await database.transaction((transaction) =>
      transaction.batch([sql<{ value: string }>`SELECT first`, sql<{ value: string }>`SELECT second`]),
    );

    strict.deepStrictEqual(results, [[{ value: "first" }], [{ value: "second" }]]);
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "SELECT second", "COMMIT"]);
    strict.strictEqual(pool.connectCount, 1);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("rolls back a failed transaction batch before releasing its client", async () => {
    const pool = new BatchPool();
    pool.client.failText = "SELECT broken";
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction((transaction) =>
          transaction.batch([sql`SELECT first`, sql`SELECT broken`, sql`SELECT never`]),
        ),
      /failed: SELECT broken/,
    );

    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "SELECT broken", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseArguments.length, 1);
  });

  await it("rejects a batch before dispatch while a transaction stream owns the client", async () => {
    const pool = new BatchPool();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      const stream = transaction.stream(sql`SELECT streamed`);
      await stream.next();
      await strict.rejects(() => transaction.batch([sql`SELECT buffered`]), /stream is still open/);
      strict.deepStrictEqual(commandText(pool.client), ["BEGIN"]);
      await stream.close();
    });
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "COMMIT"]);
  });

  await it("rejects competing transaction work while a batch owns the shared client", async () => {
    const pool = new BatchPool();
    pool.client.blockedText = "SELECT batched";
    const started = pool.client.waitForBlockedQuery();
    const database = createPostgresDatabase({ pool });
    await database.transaction(async (transaction) => {
      const batch = transaction.batch([sql`SELECT batched`]);
      await started;
      await strict.rejects(() => transaction.execute(sql`SELECT competing`), /batch is still running/);
      await strict.rejects(() => transaction.batch([sql`SELECT competing`]), /batch is still running/);
      strict.throws(() => transaction.stream(sql`SELECT competing`), /batch is still running/);
      await strict.rejects(() => transaction.transaction(async () => undefined), /batch is still running/);
      strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT batched"]);
      pool.client.continueBlockedQuery();
      await batch;
    });
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT batched", "COMMIT"]);
  });

  await it("stops an unawaited outer batch before rollback, release, or a later dispatch", async () => {
    const pool = new BatchPool();
    pool.client.blockedText = "SELECT first";
    const started = pool.client.waitForBlockedQuery();
    let escapedBatch: Promise<unknown> | undefined;
    const transaction = createPostgresDatabase({ pool }).transaction(async (scope) => {
      escapedBatch = scope.batch([sql`SELECT first`, sql`SELECT never`]);
      await started;
    });
    await started;
    pool.client.continueBlockedQuery();

    await strict.rejects(() => transaction, /returned before its query batch completed/);
    await strict.rejects(() => escapedBatch!, /transaction scope has ended/);
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseArguments.length, 1);
  });

  await it("preserves a callback failure while settling its unawaited batch before rollback", async () => {
    const pool = new BatchPool();
    pool.client.blockedText = "SELECT first";
    const started = pool.client.waitForBlockedQuery();
    const callbackError = new Error("callback failed");
    let escapedBatch: Promise<unknown> | undefined;
    const transaction = createPostgresDatabase({ pool }).transaction(async (scope) => {
      escapedBatch = scope.batch([sql`SELECT first`, sql`SELECT never`]);
      await started;
      throw callbackError;
    });
    await started;
    pool.client.continueBlockedQuery();

    await strict.rejects(
      () => transaction,
      (error) => {
        strict.strictEqual(error, callbackError);
        return true;
      },
    );
    await strict.rejects(() => escapedBatch!, /transaction scope has ended/);
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "ROLLBACK"]);
    strict.strictEqual(pool.client.releaseArguments.length, 1);
  });

  await it("stops an unawaited nested batch before rolling back its savepoint", async () => {
    const pool = new BatchPool();
    pool.client.blockedText = "SELECT nested-first";
    const started = pool.client.waitForBlockedQuery();
    let escapedBatch: Promise<unknown> | undefined;
    await createPostgresDatabase({ pool }).transaction(async (parent) => {
      const nested = parent.transaction(async (scope) => {
        escapedBatch = scope.batch([sql`SELECT nested-first`, sql`SELECT nested-never`]);
        await started;
      });
      await started;
      pool.client.continueBlockedQuery();
      await strict.rejects(() => nested, /returned before its query batch completed/);
      await strict.rejects(() => escapedBatch!, /transaction scope has ended/);
    });

    strict.deepStrictEqual(commandText(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT nested-first",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    strict.strictEqual(pool.client.releaseArguments.length, 1);
  });
});
