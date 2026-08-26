import { describe, it, strict } from "poku";
import {
  type Query,
  type QueryResult,
  type QueryResults,
  type QueryStream,
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
});
