import { sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { createDuckDBDatabase, type DuckDBNativeResult } from "../src/runtime.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";

const query = withQueryValuePlan(sql<{ value: number }>`SELECT 1 AS value`, {
  dialect: "duckdb",
  typePolicyHash: calculateTypePolicyHash(defaultDuckDBTypePolicy),
  parameters: [],
  columns: [{ name: "value", type: "number", nullable: false, databaseType: "INTEGER" }],
});
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
    strict.deepEqual(calls, ["result", "statement"]);
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
