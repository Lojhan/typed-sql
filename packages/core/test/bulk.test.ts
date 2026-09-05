import { describe, it, strict } from "poku";
import { type BulkRowPolicy, executeBulkRows, QueryCancelledError, sql } from "../src/index.js";

const rowQuery = (id: number) => sql`INSERT INTO account (id) VALUES (${id})`;
const encoder = new TextEncoder();
function policy(overrides: Partial<BulkRowPolicy> = {}) {
  const chunks: Uint8Array[] = [];
  const value: BulkRowPolicy = {
    renderer: { placeholder: () => "?", quoteIdentifier: (name) => name },
    chunkBytes: 4,
    shapeError: "changed shape",
    statement: (text) => text,
    encodeRow: (values) => encoder.encode(`${values[0]}\n`),
    transfer: async (_statement, source) => {
      for await (const chunk of source) chunks.push(chunk);
    },
    ...overrides,
  };
  return { value, chunks };
}

await describe("neutral bulk producer", async () => {
  await it("packs bounded chunks, reports progress and supports oversized rows", async () => {
    const { value, chunks } = policy();
    const progress: unknown[] = [];
    strict.deepStrictEqual(
      await executeBulkRows(rowQuery, [1, 2, 33333], { onProgress: (p) => progress.push(p) }, value),
      { rows: 3, bytes: 10 },
    );
    strict.deepStrictEqual(
      chunks.map((chunk) => new TextDecoder().decode(chunk)),
      ["1\n2\n", "33333\n"],
    );
    strict.deepStrictEqual(progress, [
      { rows: 2, bytes: 4 },
      { rows: 3, bytes: 10 },
    ]);
    const empty = policy({
      transfer: async () => {
        throw new Error("no transfer");
      },
    });
    strict.deepStrictEqual(await executeBulkRows(rowQuery, [], {}, empty.value), { rows: 0, bytes: 0 });
  });

  await it("closes synchronous producers once after early transfer success", async () => {
    let closed = 0;
    function* rows() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed++;
      }
    }
    const { value } = policy({ transfer: async () => undefined });
    await executeBulkRows(rowQuery, rows(), {}, value);
    strict.strictEqual(closed, 1);
  });

  await it("preserves producer, compilation and transport errors when cleanup also fails", async () => {
    for (const phase of ["next", "compile", "transport"] as const) {
      const failure = new Error(phase);
      let closed = 0;
      const rows: AsyncIterable<number> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (phase === "next") throw failure;
            return { done: false, value: 1 };
          },
          return: async () => {
            closed++;
            throw new Error("cleanup");
          },
        }),
      };
      const { value } = policy({
        transfer: async () => {
          throw failure;
        },
      });
      await strict.rejects(
        () =>
          executeBulkRows(
            (id) => {
              if (phase === "compile") throw failure;
              return rowQuery(id);
            },
            rows,
            {},
            value,
          ),
        (error) => error === failure,
      );
      strict.strictEqual(closed, 1);
    }
  });

  await it("handles async input, structural changes, encoding failures and cancellation", async () => {
    let closed = 0;
    async function* rows() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed++;
      }
    }
    await executeBulkRows(rowQuery, rows(), {}, policy().value);
    strict.strictEqual(closed, 1);
    await strict.rejects(
      () => executeBulkRows((id) => (id === 1 ? rowQuery(id) : sql`SELECT ${id}`), rows(), {}, policy().value),
      /changed shape/,
    );
    const failure = new Error("encode");
    await strict.rejects(
      () =>
        executeBulkRows(
          rowQuery,
          rows(),
          {},
          policy({
            encodeRow: () => {
              throw failure;
            },
          }).value,
        ),
      (error) => error === failure,
    );
    const controller = new AbortController();
    controller.abort("stopped");
    await strict.rejects(
      () => executeBulkRows(rowQuery, rows(), { signal: controller.signal }, policy().value),
      QueryCancelledError,
    );
    const mid = new AbortController();
    async function* cancelledRows() {
      yield 1;
      mid.abort("mid");
      yield 2;
    }
    await strict.rejects(
      () => executeBulkRows(rowQuery, cancelledRows(), { signal: mid.signal }, policy().value),
      QueryCancelledError,
    );
  });

  await it("closes incomplete inputs without a return method and propagates success-path cleanup failures", async () => {
    const noReturn: Iterable<number> = { [Symbol.iterator]: () => ({ next: () => ({ done: false, value: 1 }) }) };
    await executeBulkRows(rowQuery, noReturn, {}, policy({ transfer: async () => undefined }).value);
    const failure = new Error("return failed");
    const broken: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: 1 }),
        return: async () => {
          throw failure;
        },
      }),
    };
    await strict.rejects(
      () => executeBulkRows(rowQuery, broken, {}, policy({ transfer: async () => undefined }).value),
      (error) => error === failure,
    );
  });
});
