import { sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { createDuckDBDatabase, type DuckDBNativeResult } from "../src/runtime.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";

const makeQuery = () =>
  withQueryValuePlan(sql<{ value: number }>`SELECT 1 AS value`, {
    dialect: "duckdb",
    typePolicyHash: calculateTypePolicyHash(defaultDuckDBTypePolicy),
    parameters: [],
    columns: [{ name: "value", type: "number", nullable: false, databaseType: "INTEGER" }],
  });
const query = makeQuery();
for (const mode of ["query", "catalog", "stream", "control"] as const) {
  await it(`closes both resources and releases the lease after ${mode} cleanup fails`, async () => {
    const calls: string[] = [],
      failure = new Error("result close failure");
    const database = createDuckDBDatabase({
      connection: {
        libraryVersion: "2.0.0",
        async prepare() {
          return {
            async execute() {
              return {
                columns: [{ name: "value", type: { kind: "scalar", name: "INTEGER" } }],
                async readAll() {
                  return [[1]];
                },
                async *chunks() {
                  yield [[1]];
                },
                close() {
                  calls.push("result");
                  throw failure;
                },
              } satisfies DuckDBNativeResult;
            },
            close() {
              calls.push("statement");
            },
          };
        },
      },
    });
    if (mode === "query") await strict.rejects(database.all(query), (error) => error === failure);
    if (mode === "catalog")
      await strict.rejects(database.queryable.all("SELECT 1 AS value"), (error) => error === failure);
    if (mode === "stream") {
      const stream = database.stream(query);
      strict.deepEqual(await stream.next(), { done: false, value: { value: 1 } });
      await strict.rejects(stream.close(), (error) => error === failure);
    }
    if (mode === "control")
      await strict.rejects(
        database.transaction(async () => undefined),
        (error) => error === failure,
      );
    strict.deepEqual(
      calls,
      mode === "control" ? ["result", "statement", "result", "statement"] : ["result", "statement"],
    );
    await strict.rejects(database.all(query), /unusable after failed cleanup/u);
    await database.close();
  });
}
await it("preserves an execution failure while attempting all cleanup", async () => {
  const original = new Error("native read failed"),
    calls: string[] = [];
  const database = createDuckDBDatabase({
    connection: {
      libraryVersion: "2.0.0",
      async prepare() {
        return {
          async execute() {
            return {
              columns: [{ name: "value", type: { kind: "scalar", name: "INTEGER" } }],
              async readAll() {
                throw original;
              },
              close() {
                calls.push("result");
                throw new Error("secondary close failure");
              },
            };
          },
          close() {
            calls.push("statement");
            throw new Error("secondary statement failure");
          },
        };
      },
    },
  });
  await strict.rejects(database.all(query), (error) => error === original);
  strict.deepEqual(calls, ["result", "statement"]);
  await database.close();
});
await it("drains successful inflight work before reporting transaction misuse and rolling back", async () => {
  const calls: string[] = [];
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
      release = resolve;
    }),
    dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
  const database = createDuckDBDatabase({
    connection: {
      libraryVersion: "2.0.0",
      async prepare(text) {
        calls.push(`prepare:${text}`);
        return {
          async execute() {
            calls.push(`execute:${text}`);
            const user = text.startsWith("SELECT");
            return {
              columns: user ? [{ name: "value", type: { kind: "scalar", name: "INTEGER" } }] : [],
              async readAll() {
                if (user) {
                  started();
                  await blocked;
                }
                return user ? [[1]] : [];
              },
              close() {
                calls.push(`result:${text}`);
              },
            };
          },
          close() {
            calls.push(`statement:${text}`);
          },
        };
      },
    },
  });
  let settled = false;
  const pending = database.transaction(async (tx) => {
    void tx.all(query);
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await dispatched;
  strict.equal(settled, false);
  strict.equal(
    calls.some((call) => call.includes("ROLLBACK")),
    false,
  );
  release();
  await strict.rejects(pending, /unfinished operations/u);
  strict.equal(calls.filter((call) => call === "execute:BEGIN TRANSACTION").length, 1);
  strict.equal(calls.filter((call) => call === "execute:ROLLBACK").length, 1);
  strict.equal(
    calls.some((call) => call.includes("COMMIT")),
    false,
  );
  await database.close();
});
await it("validates streamed rows lazily with one global index across native chunks", async () => {
  const validated: number[] = [],
    closes: string[] = [];
  const database = createDuckDBDatabase({
    connection: {
      libraryVersion: "2.0.0",
      async prepare() {
        return {
          async execute() {
            return {
              columns: [{ name: "value", type: { kind: "scalar", name: "INTEGER" } }],
              async readAll() {
                return [];
              },
              async *chunks() {
                yield [[1], [2]];
                yield [[3], [4]];
              },
              close() {
                closes.push("result");
              },
            };
          },
          close() {
            closes.push("statement");
          },
        };
      },
    },
  });
  const schema: import("@typed-sql/core").StandardSchemaV1<{ value: number }, { value: number }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value: unknown) {
        const item = value as { value: number };
        validated.push(item.value);
        return item.value === 3 ? { issues: [{ message: "third row rejected" }] } : { value: item };
      },
    },
  };
  const checked = sql.validateResult(query, schema);
  const stream = database.stream(checked);
  strict.deepEqual(validated, []);
  strict.deepEqual((await stream.next()).value, { value: 1 });
  strict.deepEqual(validated, [1]);
  strict.deepEqual((await stream.next()).value, { value: 2 });
  strict.deepEqual(validated, [1, 2]);
  await strict.rejects(
    stream.next(),
    (error) => typeof error === "object" && error !== null && "rowIndex" in error && error.rowIndex === 2,
  );
  strict.deepEqual(validated, [1, 2, 3]);
  strict.deepEqual(closes, ["result", "statement"]);
  await database.close();
});
await it("retires every cached handle and owned connection after one close failure", async () => {
  const closes: string[] = [],
    failure = new Error("first cached statement close failed");
  let prepares = 0;
  const connection = {
    libraryVersion: "2.0.0",
    async prepare() {
      const id = ++prepares;
      return {
        async execute() {
          return {
            columns: [{ name: "value", type: { kind: "scalar" as const, name: "INTEGER" } }],
            async readAll() {
              return [[1]];
            },
            close() {},
          };
        },
        close() {
          closes.push(`statement:${id}`);
          if (id === 1) throw failure;
        },
      };
    },
    close() {
      closes.push("connection");
    },
  };
  const database = createDuckDBDatabase({ connection, ownsConnection: true }),
    sibling = createDuckDBDatabase({ connection });
  await database.all(database.prepare("first", () => query)());
  await database.all(database.prepare("second", makeQuery)());
  await strict.rejects(database.close(), (error) => error === failure);
  strict.deepEqual(closes, ["statement:1", "statement:2", "connection"]);
  await strict.rejects(sibling.all(query), /closed|unusable/u);
  strict.equal(prepares, 2);
  await database.close();
  await sibling.close();
});
await it("observes cardinality, cancellation, scoped batches and lazy streams without values", async () => {
  const starts: import("@typed-sql/core").DatabaseOperationStart[] = [],
    ends: import("@typed-sql/core").DatabaseOperationEnd[] = [];
  const database = createDuckDBDatabase({
    observer: {
      start(operation) {
        starts.push(operation);
        return {
          end(completion) {
            ends.push(completion);
          },
        };
      },
    },
    connection: {
      libraryVersion: "2.0.0",
      interrupt() {},
      async prepare(text) {
        return {
          async execute() {
            const user = text.startsWith("SELECT");
            return {
              columns: user ? [{ name: "value", type: { kind: "scalar" as const, name: "INTEGER" } }] : [],
              async readAll() {
                return user ? [[1]] : [];
              },
              async *chunks() {
                yield [[1], [2]];
              },
              close() {},
            };
          },
          close() {},
        };
      },
    },
  });
  await database.transaction(async (tx) => {
    await tx.all(query);
  });
  strict.equal(starts[0]?.kind, "transaction");
  strict.equal(starts[1]?.transactionDepth, 1);
  await database.batch([query]);
  strict.ok(starts.some((operation) => operation.kind === "batch" && operation.size === 1));
  const before = starts.length,
    stream = database.stream(query);
  strict.equal(starts.length, before);
  await stream.next();
  await stream.close();
  strict.equal(starts.at(-1)?.kind, "stream");
  strict.equal(ends.at(-1)?.rowCount, 1);
  const abort = new AbortController();
  abort.abort();
  await strict.rejects(database.all(query, { signal: abort.signal }), /cancelled/u);
  strict.equal(ends.at(-1)?.status, "cancelled");
  strict.equal(ends.at(-1)?.cancellationReason, "signal");
  strict.equal(
    ends.some((completion) => "cause" in completion),
    false,
  );
  strict.equal(JSON.stringify(starts).includes("SELECT"), false);
  await database.close();
});
await it("snapshots native bytes synchronously before yielding to the operation queue", async () => {
  const input = Buffer.from([1, 2, 3]),
    captured: unknown[] = [];
  const statement = withQueryValuePlan(sql`INSERT INTO blobs VALUES(${input})`, {
    dialect: "duckdb",
    typePolicyHash: calculateTypePolicyHash(defaultDuckDBTypePolicy),
    columns: [],
    parameters: [{ index: 1, type: "bytes", nullable: false, databaseType: "BLOB" }],
  });
  const database = createDuckDBDatabase({
    connection: {
      libraryVersion: "2.0.0",
      async prepare() {
        return {
          async execute(bindings) {
            captured.push(bindings[0]?.value);
            return {
              columns: [],
              async readAll() {
                return [];
              },
              close() {},
            };
          },
          close() {},
        };
      },
    },
  });
  const pending = database.all(statement);
  input.fill(9);
  await pending;
  strict.deepEqual(captured, [Uint8Array.of(1, 2, 3)]);
  await database.close();
});
