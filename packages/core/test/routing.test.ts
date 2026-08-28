import { describe, it, strict } from "poku";
import {
  createRoutedDatabase,
  type Database,
  defineQuerySemantics,
  type ExecutionCapabilities,
  type ExecutionOptions,
  type Query,
  QueryCancelledError,
  type QuerySemantics,
  queryRoute,
  sql,
  type TransactionDatabase,
  UnsafeReplicaRoutingError,
} from "../src/index.js";

const range = { start: 0, end: 1, line: 1, column: 1 } as const;
const evidence = [{ kind: "syntax" as const, description: "test", range }];

function semantics(
  overrides: {
    readonly operation?: QuerySemantics["operation"]["value"];
    readonly volatility?: QuerySemantics["volatility"]["value"];
    readonly locking?: QuerySemantics["locking"]["value"];
    readonly affinity?: QuerySemantics["connectionAffinity"]["value"];
  } = {},
): QuerySemantics {
  return defineQuerySemantics({
    version: 1,
    operation: { value: overrides.operation ?? "read", evidence },
    dependencies: [],
    cardinality: { minimum: 0, maximum: "many", evidence },
    volatility: { value: overrides.volatility ?? "stable", evidence },
    locking: { value: overrides.locking ?? "none", evidence },
    connectionAffinity: { value: overrides.affinity ?? "none", evidence },
    capabilities: [],
  });
}

interface FakeDatabaseOptions {
  readonly capabilities?: ExecutionCapabilities;
  readonly execute?: (query: object) => readonly unknown[] | Promise<readonly unknown[]>;
  readonly beginErrors?: unknown[];
  readonly commitErrors?: unknown[];
}

function fakeDatabase(name: string, calls: string[], options: FakeDatabaseOptions = {}): Database {
  let database!: Database;
  const transaction = async <T>(fn: (value: TransactionDatabase) => Promise<T>): Promise<T> => {
    calls.push(`${name}:begin`);
    const beginError = options.beginErrors?.shift();
    if (beginError !== undefined) throw beginError;
    try {
      const value = await fn(database as TransactionDatabase);
      const commitError = options.commitErrors?.shift();
      if (commitError !== undefined) throw commitError;
      calls.push(`${name}:commit`);
      return value;
    } catch (error) {
      calls.push(`${name}:rollback`);
      throw error;
    }
  };
  const run = async <Row, Params extends readonly unknown[]>(query: Query<Row, Params>): Promise<readonly Row[]> => {
    calls.push(name);
    return ((await options.execute?.(query)) as readonly Row[]) ?? ([{ database: name }] as Row[]);
  };
  database = {
    executionCapabilities: options.capabilities ?? { cancellation: true, deadlines: true },
    execute<Row, Params extends readonly unknown[]>(query: Query<Row, Params>) {
      return run(query);
    },
    all<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, _options?: ExecutionOptions) {
      return run(query);
    },
    async one<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, _options?: ExecutionOptions) {
      return (await run(query))[0]!;
    },
    async maybeOne<Row, Params extends readonly unknown[]>(query: Query<Row, Params>, _options?: ExecutionOptions) {
      return (await run(query))[0];
    },
    transaction,
  };
  return database;
}

function resolver(values: ReadonlyMap<object, QuerySemantics>) {
  return {
    resolve<Row, Params extends readonly unknown[]>(query: Query<Row, Params>) {
      return values.get(query) ?? semantics({ operation: "unknown" });
    },
  };
}

await describe("grammar-neutral semantic routing", async () => {
  await it("routes only proven side-effect-free, non-locking reads to replicas", () => {
    strict.strictEqual(queryRoute(semantics()), "replica");
    strict.strictEqual(queryRoute(semantics({ volatility: "immutable" })), "replica");
    strict.strictEqual(queryRoute(semantics({ operation: "write" })), "primary");
    strict.strictEqual(queryRoute(semantics({ operation: "unknown" })), "primary");
    strict.strictEqual(queryRoute(semantics({ volatility: "volatile" })), "primary");
    strict.strictEqual(queryRoute(semantics({ volatility: "unknown" })), "primary");
    strict.strictEqual(queryRoute(semantics({ locking: "row" })), "primary");
    strict.strictEqual(queryRoute(semantics({ affinity: "session" })), "primary");
    strict.strictEqual(queryRoute(semantics({ affinity: "transaction" })), "primary");
  });

  await it("round-robins safe reads and pins an explicit context after a write", async () => {
    const calls: string[] = [];
    const read = sql`SELECT id FROM account`;
    const write = sql`UPDATE account SET active = TRUE`;
    const selections: string[] = [];
    const database = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      replicas: [fakeDatabase("replica-1", calls), fakeDatabase("replica-2", calls)],
      semantics: resolver(
        new Map([
          [read, semantics()],
          [write, semantics({ operation: "write" })],
        ]),
      ),
      observer: { route: ({ route }) => selections.push(route) },
    });

    await database.execute(read);
    await database.all(read, { deadline: Date.now() + 1_000 });
    const context = database.context();
    await context.execute(read);
    await context.execute(write);
    await context.execute(read);
    await database.execute(read);

    strict.deepStrictEqual(calls, ["replica-1", "replica-2", "replica-1", "primary", "primary", "replica-2"]);
    strict.deepStrictEqual(selections, ["replica", "replica", "replica", "primary", "primary", "replica"]);
  });

  await it("supports explicit primary and safe replica views while rejecting unsafe requests before dispatch", async () => {
    const calls: string[] = [];
    const read = sql`SELECT 1`;
    const write = sql`DELETE FROM account`;
    const database = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      replicas: [fakeDatabase("replica", calls)],
      semantics: resolver(
        new Map([
          [read, semantics()],
          [write, semantics({ operation: "write" })],
        ]),
      ),
    });

    await database.withRoute("primary").one(read);
    await database.context().withRoute("replica").maybeOne(read);
    await strict.rejects(
      database.withRoute("replica").execute(write),
      (error: unknown) =>
        error instanceof UnsafeReplicaRoutingError &&
        error.code === "TSQL_UNSAFE_REPLICA_ROUTE" &&
        error.reason === "query-not-replica-safe",
    );
    const pinned = database.context();
    pinned.pinPrimary();
    await strict.rejects(
      pinned.withRoute("replica").execute(read),
      (error: unknown) => error instanceof UnsafeReplicaRoutingError && error.reason === "primary-pinned",
    );
    strict.deepStrictEqual(calls, ["primary", "replica"]);
    strict.throws(() => database.withRoute("invalid" as never), /auto, primary, or replica/);
  });

  await it("falls back to primary for automatic uncertainty and reports unavailable or invalid replicas", async () => {
    const calls: string[] = [];
    const read = sql`SELECT 1`;
    const throwing = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      semantics: {
        resolve: () => {
          throw new Error("analysis failed");
        },
      },
    });
    await throwing.execute(read);
    await strict.rejects(
      throwing.withRoute("replica").execute(read),
      (error: unknown) => error instanceof UnsafeReplicaRoutingError && error.reason === "query-not-replica-safe",
    );

    const noReplica = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      semantics: resolver(new Map([[read, semantics()]])),
    });
    await noReplica.execute(read);
    await strict.rejects(
      noReplica.withRoute("replica").execute(read),
      (error: unknown) => error instanceof UnsafeReplicaRoutingError && error.reason === "replica-unavailable",
    );

    const invalid = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      replicas: [fakeDatabase("replica", calls)],
      semantics: resolver(new Map([[read, semantics()]])),
      selectReplica: () => 2,
    });
    await strict.rejects(invalid.execute(read), /invalid replica index/);
    strict.deepStrictEqual(calls, ["primary", "primary"]);
  });

  await it("uses an injected selector, isolates observer failures, and advertises conservative capabilities", async () => {
    const calls: string[] = [];
    const read = sql`SELECT 1`;
    const database = createRoutedDatabase({
      primary: fakeDatabase("primary", calls),
      replicas: [
        fakeDatabase("replica-1", calls),
        fakeDatabase("replica-2", calls, { capabilities: { cancellation: false, deadlines: true } }),
      ],
      semantics: resolver(new Map([[read, semantics()]])),
      selectReplica: ({ replicaCount, roundRobinIndex }) => {
        strict.strictEqual(replicaCount, 2);
        return (roundRobinIndex + 1) % replicaCount;
      },
      observer: {
        route: () => {
          throw new Error("observer failed");
        },
      },
    });
    strict.deepStrictEqual(database.executionCapabilities, { cancellation: false, deadlines: true });
    await database.execute(read);
    await database.execute(read);
    strict.deepStrictEqual(calls, ["replica-2", "replica-1"]);
  });

  await it("validates topology collaborators", () => {
    const calls: string[] = [];
    const primary = fakeDatabase("primary", calls);
    strict.throws(
      () => createRoutedDatabase({ primary, replicas: [primary], semantics: resolver(new Map()) }),
      /cannot also be configured as a replica/,
    );
    strict.throws(() => createRoutedDatabase({ primary, semantics: {} as never }), /semantic resolver/);
    strict.throws(
      () => createRoutedDatabase({ primary, semantics: resolver(new Map()), selectReplica: 1 as never }),
      /selectReplica/,
    );
    strict.throws(
      () => createRoutedDatabase({ primary, semantics: resolver(new Map()), observer: {} as never }),
      /observer/,
    );
  });
});

await describe("explicit transaction retries", async () => {
  const retryable = () => Object.assign(new Error("serialization"), { code: "40001" });

  await it("retries marked database failures with deterministic backoff and keeps every attempt on primary", async () => {
    const calls: string[] = [];
    const query = sql<{ readonly ok: boolean }, readonly []>`UPDATE account SET active = TRUE`;
    let failures = 2;
    const primary = fakeDatabase("primary", calls, {
      execute: () => {
        if (failures-- > 0) throw retryable();
        return [{ ok: true }];
      },
    });
    const retries: number[] = [];
    const sleeps: number[] = [];
    const database = createRoutedDatabase({
      primary,
      replicas: [fakeDatabase("replica", calls)],
      semantics: resolver(new Map([[query, semantics({ operation: "write" })]])),
    });
    const value = await database.transaction(
      async (transaction) => (await transaction.one<{ ok: boolean }, readonly []>(query)).ok,
      {
        retry: {
          maximumAttempts: 3,
          classify: (error) => (error as { code?: string }).code === "40001",
          backoff: ({ attempt }) => attempt * 5,
          sleep: async (delay) => {
            sleeps.push(delay);
          },
          onRetry: ({ attempt }) => retries.push(attempt),
        },
      },
    );
    strict.strictEqual(value, true);
    strict.deepStrictEqual(retries, [1, 2]);
    strict.deepStrictEqual(sleeps, [5, 10]);
    strict.strictEqual(calls.includes("replica"), false);
    strict.strictEqual(calls.filter((call) => call === "primary:begin").length, 3);
  });

  await it("retries transient commit failures but never retries callback or non-transient failures", async () => {
    const calls: string[] = [];
    const primary = fakeDatabase("primary", calls, { commitErrors: [retryable()] });
    const database = createRoutedDatabase({ primary, semantics: resolver(new Map()) });
    let callbacks = 0;
    strict.strictEqual(
      await database.transaction(async () => ++callbacks, {
        retry: { maximumAttempts: 2, classify: (error) => (error as { code?: string }).code === "40001" },
      }),
      2,
    );

    callbacks = 0;
    await strict.rejects(
      database.transaction(
        async () => {
          callbacks += 1;
          throw retryable();
        },
        { retry: { maximumAttempts: 3, classify: () => true } },
      ),
      /serialization/,
    );
    strict.strictEqual(callbacks, 1);

    const query = sql`SELECT 1`;
    const permanent = new Error("constraint");
    const failing = createRoutedDatabase({
      primary: fakeDatabase("primary", calls, {
        execute: () => {
          throw permanent;
        },
      }),
      semantics: resolver(new Map([[query, semantics()]])),
    });
    await strict.rejects(
      failing.transaction((transaction) => transaction.execute(query).then(() => undefined), {
        retry: { maximumAttempts: 3, classify: () => false },
      }),
      /constraint/,
    );
  });

  await it("retries transient failures that happen before the transaction callback starts", async () => {
    const calls: string[] = [];
    const primary = fakeDatabase("primary", calls, { beginErrors: [retryable()] });
    const database = createRoutedDatabase({ primary, semantics: resolver(new Map()) });
    let callbacks = 0;
    strict.strictEqual(
      await database.transaction(async () => ++callbacks, {
        retry: { maximumAttempts: 2, classify: (error) => (error as { code?: string }).code === "40001" },
      }),
      1,
    );
    strict.strictEqual(callbacks, 1);
    strict.deepStrictEqual(calls, ["primary:begin", "primary:begin", "primary:commit"]);
  });

  await it("bounds attempts, ignores retry observer errors, and validates retry policy", async () => {
    const calls: string[] = [];
    const query = sql`SELECT 1`;
    const database = createRoutedDatabase({
      primary: fakeDatabase("primary", calls, {
        execute: () => {
          throw retryable();
        },
      }),
      semantics: resolver(new Map([[query, semantics()]])),
    });
    await strict.rejects(
      database.transaction((transaction) => transaction.execute(query).then(() => undefined), {
        retry: {
          maximumAttempts: 2,
          classify: () => true,
          onRetry: () => {
            throw new Error("observer");
          },
        },
      }),
      /serialization/,
    );
    strict.strictEqual(calls.filter((call) => call === "primary:begin").length, 2);

    const routingFailureCalls: string[] = [];
    const routingFailure = createRoutedDatabase({
      primary: fakeDatabase("primary", routingFailureCalls),
      semantics: resolver(new Map([[query, semantics()]])),
    });
    await strict.rejects(
      routingFailure.transaction(
        (transaction) =>
          transaction
            .withRoute("replica")
            .execute(query)
            .then(() => undefined),
        { retry: { maximumAttempts: 3, classify: () => true } },
      ),
      (error: unknown) => error instanceof UnsafeReplicaRoutingError && error.reason === "primary-pinned",
    );
    strict.deepStrictEqual(routingFailureCalls, ["primary:begin", "primary:rollback"]);

    await strict.rejects(
      database.transaction(async () => undefined, { retry: { maximumAttempts: 0, classify: () => true } }),
      /positive safe integer/,
    );
    await strict.rejects(
      database.transaction(async () => undefined, { retry: { maximumAttempts: 2, classify: 1 as never } }),
      /classify/,
    );
    for (const invalid of [{ backoff: 1 }, { sleep: 1 }, { onRetry: 1 }]) {
      await strict.rejects(
        database.transaction(async () => undefined, {
          retry: { maximumAttempts: 2, classify: () => true, ...invalid } as never,
        }),
        /must be a function/,
      );
    }
  });

  await it("rejects invalid delays and supports pre-abort and abortable default waits", async () => {
    const calls: string[] = [];
    const query = sql`SELECT 1`;
    const database = createRoutedDatabase({
      primary: fakeDatabase("primary", calls, {
        execute: () => {
          throw retryable();
        },
      }),
      semantics: resolver(new Map([[query, semantics()]])),
    });
    await strict.rejects(
      database.transaction((transaction) => transaction.execute(query).then(() => undefined), {
        retry: { maximumAttempts: 2, classify: () => true, backoff: () => -1 },
      }),
      /between 0 and/,
    );
    await strict.rejects(
      database.transaction((transaction) => transaction.execute(query).then(() => undefined), {
        retry: { maximumAttempts: 2, classify: () => true, backoff: () => 2_147_483_648 },
      }),
      /between 0 and/,
    );

    const preAborted = new AbortController();
    preAborted.abort("closed");
    await strict.rejects(
      database.transaction(async () => undefined, {
        retry: { maximumAttempts: 2, classify: () => true, signal: preAborted.signal },
      }),
      (error: unknown) => error instanceof QueryCancelledError && error.cause === "closed",
    );

    const controller = new AbortController();
    const waiting = database.transaction((transaction) => transaction.execute(query).then(() => undefined), {
      retry: {
        maximumAttempts: 2,
        classify: () => true,
        backoff: () => 10_000,
        signal: controller.signal,
      },
    });
    setTimeout(() => controller.abort("cancel-wait"), 0);
    await strict.rejects(
      waiting,
      (error: unknown) => error instanceof QueryCancelledError && error.cause === "cancel-wait",
    );
  });
});
