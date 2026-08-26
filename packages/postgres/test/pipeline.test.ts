import type { Query, QueryResults } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import {
  createPostgresDatabase,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "../src/runtime.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

interface DeferredResult {
  readonly promise: Promise<PostgresQueryResult>;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: PostgresQueryResult) => void;
}

function deferredResult(): DeferredResult {
  let reject!: (error: Error) => void;
  let resolve!: (result: PostgresQueryResult) => void;
  const promise = new Promise<PostgresQueryResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class PipelineClient implements PostgresClientLike {
  pipeline = true;
  readonly calls: (PostgresQueryConfig | string)[] = [];
  readonly releaseArguments: (Error | boolean | undefined)[] = [];
  readonly rows = new Map<string, readonly Record<string, unknown>[]>();
  readonly errors = new Map<string, Error>();
  readonly #blocked = new Map<string, DeferredResult>();
  readonly #callWaiters: { readonly count: number; readonly resolve: () => void }[] = [];

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    this.#resolveCallWaiters();
    const text = typeof config === "string" ? config : config.text;
    const blocked = this.#blocked.get(text);
    if (blocked !== undefined) return blocked.promise;
    const error = this.errors.get(text);
    if (error !== undefined) throw error;
    return { rows: this.rows.get(text) ?? [] };
  }

  block(text: string): void {
    this.#blocked.set(text, deferredResult());
  }

  resolve(text: string, rows: readonly Record<string, unknown>[] = []): void {
    this.#blocked.get(text)?.resolve({ rows });
  }

  reject(text: string, error: Error): void {
    this.#blocked.get(text)?.reject(error);
  }

  waitForCalls(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#callWaiters.push({ count, resolve }));
  }

  release(error?: Error | boolean): void {
    this.releaseArguments.push(error);
  }

  #resolveCallWaiters(): void {
    for (let index = this.#callWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#callWaiters[index]!;
      if (this.calls.length < waiter.count) continue;
      this.#callWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

class PipelinePool implements PostgresPoolLike {
  readonly client = new PipelineClient();
  connectCount = 0;

  async query(): Promise<PostgresQueryResult> {
    return { rows: [] };
  }

  async connect(): Promise<PostgresClientLike> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {}
}

function commandText(client: PipelineClient): string[] {
  return client.calls.map((call) => (typeof call === "string" ? call : call.text));
}

const accountQuery = sql<{ id: bigint; email: string }>`SELECT id, email FROM account`;
const projectQuery = sql<{ id: bigint; budget: string | null }>`SELECT id, budget FROM project`;

await describe("PostgreSQL query pipelines", async () => {
  await it("preserves exact tuple and homogeneous-array result types", async () => {
    const database = createPostgresDatabase({ pool: new PipelinePool() });
    const tuple = database.pipeline([accountQuery, projectQuery]);
    const exactTuple: Assert<
      Equal<
        Awaited<typeof tuple>,
        readonly [readonly { id: bigint; email: string }[], readonly { id: bigint; budget: string | null }[]]
      >
    > = true;
    const queries = [1n, 2n].map(
      (id): Query<{ id: bigint }, readonly [bigint]> => sql`SELECT id FROM account WHERE id = ${id}`,
    );
    const array = database.pipeline(queries);
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

    const rejectsNonQueries = (): Promise<unknown> => {
      // @ts-expect-error Every pipeline member must be a typed Query.
      return database.pipeline([accountQuery, "SELECT 1"]);
    };
    void rejectsNonQueries;
  });

  await it("returns an empty result without acquiring a connection", async () => {
    const pool = new PipelinePool();
    const result = await createPostgresDatabase({ pool }).pipeline([]);
    strict.deepStrictEqual(result, []);
    strict.strictEqual(pool.connectCount, 0);
  });

  await it("requires documented pg pipeline mode before dispatch", async () => {
    const pool = new PipelinePool();
    pool.client.pipeline = false;
    await strict.rejects(
      () => createPostgresDatabase({ pool }).pipeline([accountQuery]),
      /Pool with \{ pipeline: true \}/,
    );
    strict.strictEqual(pool.connectCount, 1);
    strict.deepStrictEqual(pool.client.calls, []);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("dispatches every query before awaiting and returns results in input order", async () => {
    const pool = new PipelinePool();
    for (const text of ["SELECT first", "SELECT second", "SELECT third"]) pool.client.block(text);
    const database = createPostgresDatabase({ pool });
    const prepared = database.prepare("pipeline-second", () => sql<{ value: string }>`SELECT second`);
    const result = database.pipeline([
      sql<{ value: string }>`SELECT first`,
      prepared(),
      sql<{ value: string }>`SELECT third`,
    ]);

    await pool.client.waitForCalls(3);
    strict.deepStrictEqual(commandText(pool.client), ["SELECT first", "SELECT second", "SELECT third"]);
    const secondConfig = pool.client.calls[1];
    if (secondConfig === undefined || typeof secondConfig === "string") strict.fail("Expected prepared query config");
    else strict.strictEqual(secondConfig.name, "pipeline-second");
    strict.deepStrictEqual(pool.client.releaseArguments, []);

    pool.client.resolve("SELECT third", [{ value: "third" }]);
    pool.client.resolve("SELECT first", [{ value: "first" }]);
    pool.client.resolve("SELECT second", [{ value: "second" }]);
    strict.deepStrictEqual(await result, [[{ value: "first" }], [{ value: "second" }], [{ value: "third" }]]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("waits for every in-flight query and reports the first input-order rejection", async () => {
    const pool = new PipelinePool();
    for (const text of ["SELECT first", "SELECT second", "SELECT third"]) pool.client.block(text);
    const firstError = new Error("first pipeline query failed");
    const secondError = new Error("second pipeline query failed");
    const operation = createPostgresDatabase({ pool }).pipeline([
      sql`SELECT first`,
      sql`SELECT second`,
      sql`SELECT third`,
    ]);

    await pool.client.waitForCalls(3);
    pool.client.reject("SELECT second", secondError);
    pool.client.reject("SELECT first", firstError);
    await Promise.resolve();
    strict.deepStrictEqual(pool.client.releaseArguments, []);
    pool.client.resolve("SELECT third");
    await strict.rejects(
      () => operation,
      (error) => {
        strict.strictEqual(error, firstError);
        return true;
      },
    );
    strict.deepStrictEqual(pool.client.releaseArguments, [firstError]);
  });
});

await describe("PostgreSQL transaction query pipelines", async () => {
  await it("pipelines on the transaction client and commits after all results", async () => {
    const pool = new PipelinePool();
    pool.client.rows.set("SELECT first", [{ value: "first" }]);
    pool.client.rows.set("SELECT second", [{ value: "second" }]);
    const database = createPostgresDatabase({ pool });

    await database.transaction(async (transaction) => {
      strict.deepStrictEqual(
        await transaction.pipeline([sql<{ value: string }>`SELECT first`, sql<{ value: string }>`SELECT second`]),
        [[{ value: "first" }], [{ value: "second" }]],
      );
    });

    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "SELECT second", "COMMIT"]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("rolls back a caught pipeline failure and discards the lease", async () => {
    const pool = new PipelinePool();
    const queryError = new Error("pipeline query failed");
    pool.client.errors.set("SELECT broken", queryError);
    const database = createPostgresDatabase({ pool });

    await strict.rejects(
      () =>
        database.transaction(async (transaction) => {
          await strict.rejects(
            () => transaction.pipeline([sql`SELECT first`, sql`SELECT broken`, sql`SELECT still_dispatched`]),
            queryError,
          );
        }),
      queryError,
    );

    strict.deepStrictEqual(commandText(pool.client), [
      "BEGIN",
      "SELECT first",
      "SELECT broken",
      "SELECT still_dispatched",
      "ROLLBACK",
    ]);
    strict.deepStrictEqual(pool.client.releaseArguments, [queryError]);
  });

  await it("recovers the parent through a savepoint after a nested pipeline failure", async () => {
    const pool = new PipelinePool();
    const queryError = new Error("nested pipeline failed");
    pool.client.errors.set("SELECT nested_broken", queryError);
    const database = createPostgresDatabase({ pool });

    await database.transaction(async (parent) => {
      await strict.rejects(
        () =>
          parent.transaction((nested) =>
            nested.pipeline([sql`SELECT nested_first`, sql`SELECT nested_broken`, sql`SELECT nested_dispatched`]),
          ),
        queryError,
      );
      await parent.execute(sql`SELECT parent_recovered`);
    });

    strict.deepStrictEqual(commandText(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT nested_first",
      "SELECT nested_broken",
      "SELECT nested_dispatched",
      "ROLLBACK TO SAVEPOINT typed_sql_2",
      "SELECT parent_recovered",
      "COMMIT",
    ]);
    strict.deepStrictEqual(pool.client.releaseArguments, [queryError]);
  });

  await it("settles an unawaited pipeline before rolling back without selecting commit", async () => {
    const pool = new PipelinePool();
    pool.client.block("SELECT first");
    pool.client.block("SELECT second");
    const database = createPostgresDatabase({ pool });
    let escaped: Promise<unknown> | undefined;

    const transaction = database.transaction(async (scope) => {
      escaped = scope.pipeline([sql`SELECT first`, sql`SELECT second`]);
      void escaped.catch(() => undefined);
      await pool.client.waitForCalls(3);
    });
    void transaction.catch(() => undefined);

    await pool.client.waitForCalls(3);
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "SELECT second"]);
    pool.client.resolve("SELECT first");
    pool.client.resolve("SELECT second");
    await escaped;
    await strict.rejects(() => transaction, /await the pipeline before returning/);
    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT first", "SELECT second", "ROLLBACK"]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("lets the parent settle a pipeline owned by an unawaited nested scope", async () => {
    const pool = new PipelinePool();
    pool.client.block("SELECT nested_first");
    pool.client.block("SELECT nested_second");
    const database = createPostgresDatabase({ pool });
    let escaped: Promise<unknown> | undefined;
    let nestedTransaction: Promise<void> | undefined;

    const transaction = database.transaction(async (parent) => {
      nestedTransaction = parent.transaction(async (nested) => {
        escaped = nested.pipeline([sql`SELECT nested_first`, sql`SELECT nested_second`]);
        void escaped.catch(() => undefined);
        await pool.client.waitForCalls(4);
      });
      void nestedTransaction.catch(() => undefined);
      await pool.client.waitForCalls(4);
    });
    void transaction.catch(() => undefined);

    await pool.client.waitForCalls(4);
    strict.deepStrictEqual(commandText(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT nested_first",
      "SELECT nested_second",
    ]);
    pool.client.resolve("SELECT nested_first");
    pool.client.resolve("SELECT nested_second");
    await escaped;
    await strict.rejects(() => nestedTransaction!, /parent PostgreSQL transaction scope ended|await the pipeline/);
    await strict.rejects(() => transaction, /await the pipeline before returning/);
    strict.deepStrictEqual(commandText(pool.client), [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "SELECT nested_first",
      "SELECT nested_second",
      "ROLLBACK",
    ]);
    strict.deepStrictEqual(pool.client.releaseArguments, [undefined]);
  });

  await it("rejects competing connection work while a pipeline is active", async () => {
    const pool = new PipelinePool();
    pool.client.block("SELECT pipelined");
    const database = createPostgresDatabase({ pool });

    await database.transaction(async (transaction) => {
      const operation = transaction.pipeline([sql`SELECT pipelined`]);
      await pool.client.waitForCalls(2);
      await strict.rejects(() => transaction.execute(sql`SELECT competing`), /pipeline is still running/);
      await strict.rejects(() => transaction.batch([sql`SELECT competing`]), /pipeline is still running/);
      strict.throws(() => transaction.stream(sql`SELECT competing`), /pipeline is still running/);
      await strict.rejects(() => transaction.transaction(async () => undefined), /pipeline is still running/);
      pool.client.resolve("SELECT pipelined");
      await operation;
    });

    strict.deepStrictEqual(commandText(pool.client), ["BEGIN", "SELECT pipelined", "COMMIT"]);
  });
});
