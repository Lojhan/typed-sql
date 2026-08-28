import { describe, it, strict } from "poku";
import {
  type Query,
  QueryCancelledError,
  type QueryResult,
  type QueryResults,
  type QueryStream,
  runControlledExecution,
  type StreamOptions,
  sql,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

type Account = { readonly id: bigint; readonly email: string };
type Project = { readonly id: bigint; readonly ownerId: bigint };

const accountQuery = sql<Account, readonly [bigint]>`SELECT id, email FROM account WHERE id = ${1n}`;
const projectQuery = sql<Project, readonly []>`SELECT id, owner_id FROM project`;

function inferBatchResults<const Queries extends readonly unknown[]>(queries: Queries): QueryResults<Queries> {
  void queries;
  return [] as unknown as QueryResults<Queries>;
}

await describe("grammar-neutral execution capability types", async () => {
  await it("maps one query to its readonly buffered rows", () => {
    const exact: Assert<Equal<QueryResult<typeof accountQuery>, readonly Account[]>> = true;
    const unsupported: Assert<Equal<QueryResult<{ readonly text: string }>, never>> = true;
    strict.strictEqual(exact, true);
    strict.strictEqual(unsupported, true);
  });

  await it("preserves heterogeneous inline tuples without an as-const assertion", () => {
    const results = inferBatchResults([accountQuery, projectQuery]);
    const exact: Assert<Equal<typeof results, readonly [readonly Account[], readonly Project[]]>> = true;
    strict.strictEqual(exact, true);
  });

  await it("preserves homogeneous mapped arrays", () => {
    const queries = [1n, 2n].map(
      (id): Query<Account, readonly [bigint]> => sql`SELECT id, email FROM account WHERE id = ${id}`,
    );
    const results = inferBatchResults(queries);
    const exact: Assert<Equal<typeof results, readonly (readonly Account[])[]>> = true;
    strict.strictEqual(exact, true);
  });

  await it("defines a closeable async-iterator lifecycle without cancellation", async () => {
    let closeCount = 0;
    const stream: QueryStream<Account> = {
      async next() {
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async close() {
        closeCount += 1;
      },
      async [Symbol.asyncDispose]() {
        await this.close();
      },
    };

    const options = { batchSize: 500 } satisfies StreamOptions;
    // @ts-expect-error cancellation is intentionally absent until adapters share safe semantics
    const unsupportedOptions: StreamOptions = { signal: new AbortController().signal };
    void unsupportedOptions;

    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });
    await stream[Symbol.asyncDispose]();
    strict.strictEqual(closeCount, 1);
    strict.strictEqual(options.batchSize, 500);
  });

  await it("coordinates pre-abort, in-flight abort, deadlines, and successful completion", async () => {
    const preAborted = new AbortController();
    preAborted.abort("request-closed");
    let dispatched = false;
    await strict.rejects(
      runControlledExecution(
        { signal: preAborted.signal },
        async () => {
          dispatched = true;
          return 1;
        },
        () => undefined,
      ),
      (error: unknown) =>
        error instanceof QueryCancelledError && error.reason === "signal" && error.cause === "request-closed",
    );
    strict.strictEqual(dispatched, false);

    const controller = new AbortController();
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<number>((_resolve, reject) => {
      rejectOperation = reject;
    });
    let cancellations = 0;
    const controlled = runControlledExecution(
      { signal: controller.signal },
      () => operation,
      (error) => {
        cancellations += 1;
        rejectOperation(error);
      },
    );
    controller.abort();
    await strict.rejects(
      controlled,
      (error: unknown) => error instanceof QueryCancelledError && error.reason === "signal",
    );
    strict.strictEqual(cancellations, 1);

    const dispatchController = new AbortController();
    await strict.rejects(
      runControlledExecution(
        { signal: dispatchController.signal },
        () => {
          dispatchController.abort("during-dispatch");
          return Promise.resolve(1);
        },
        () => {
          throw new Error("adapter cleanup failed");
        },
      ),
      (error: unknown) =>
        error instanceof QueryCancelledError && error.reason === "signal" && error.cause === "during-dispatch",
    );

    await strict.rejects(
      runControlledExecution(
        { deadline: Date.now() - 1 },
        async () => 1,
        () => undefined,
      ),
      (error: unknown) => error instanceof QueryCancelledError && error.reason === "deadline",
    );
    strict.strictEqual(
      await runControlledExecution(
        { deadline: new Date(Date.now() + 1_000) },
        async () => 42,
        () => undefined,
      ),
      42,
    );
  });
});
