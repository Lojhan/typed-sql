import { QueryCancelledError, requireAdapterCapability, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { it, strict } from "poku";
import { createDuckDBDatabase, duckdbAppender } from "../src/runtime.js";
import { defaultDuckDBTypePolicy } from "../src/type-policy.js";
import { fixtureEvidence } from "./helpers/evidence.js";

const factory = (value: number) =>
  withQueryValuePlan(sql`INSERT INTO target(value) VALUES(${value})`, {
    dialect: "duckdb",
    typePolicyHash: calculateTypePolicyHash(defaultDuckDBTypePolicy),
    parameters: [{ index: 1, databaseType: "INTEGER", type: "number", nullable: false }],
    columns: [],
  });
const integer = { kind: "scalar" as const, name: "INTEGER" };
function fixture(stop: string, abort: AbortController) {
  const dispatched: string[] = [],
    cleaned: string[] = [];
  let health = 0;
  const stopAt = (stage: string) => {
    if (stage === stop) abort.abort();
  };
  const database = createDuckDBDatabase({
    connection: {
      libraryVersion: "2.0.0",
      async readServerEvidence() {
        const stage = `health${++health}`;
        dispatched.push(stage);
        stopAt(stage);
        return fixtureEvidence("2.0.0");
      },
      async prepare(text) {
        const kind = text.startsWith("CREATE")
          ? "CREATE"
          : text.startsWith("DROP")
            ? "DROP"
            : text.includes(" SELECT ")
              ? "INSERT"
              : text.startsWith("INSERT")
                ? "initial"
                : text.split(" ")[0]!;
        dispatched.push(kind);
        if (kind === "initial") stopAt(kind);
        return {
          async execute() {
            stopAt(kind);
            return {
              columns: [],
              async readAll() {
                return [];
              },
              close() {
                cleaned.push(`result:${kind}`);
              },
            };
          },
          close() {
            cleaned.push(`statement:${kind}`);
          },
        };
      },
      async createAppender() {
        dispatched.push("appender");
        stopAt("appender");
        return {
          columns: [integer],
          async append() {
            dispatched.push("append");
            stopAt("append");
          },
          close() {
            cleaned.push("appender");
          },
        };
      },
      interrupt() {
        cleaned.push("interrupt");
      },
    },
  });
  return { database, dispatched, cleaned };
}

for (const scoped of [false, true]) {
  await it(`dispatches no appender work for pre-cancelled ${scoped ? "scoped" : "root"} transfers`, async () => {
    const abort = new AbortController(),
      state = fixture("never", abort);
    abort.abort();
    const run = async (database: Parameters<typeof requireAdapterCapability>[0]) => {
      const before = [...state.dispatched];
      const appender = requireAdapterCapability(database, duckdbAppender);
      for (const controls of [{ signal: abort.signal }, { deadline: Date.now() - 1 }]) {
        await strict.rejects(appender.append(factory, [1], controls), (error) => error instanceof QueryCancelledError);
        strict.deepEqual(state.dispatched, before);
      }
    };
    if (scoped)
      await strict.rejects(
        state.database.transaction(async (tx) => run(tx)),
        (error) => error instanceof QueryCancelledError,
      );
    else await run(state.database);
    await state.database.close();
  });

  for (const stop of ["health2", "initial", "CREATE", "appender", "append", "INSERT", "DROP"]) {
    await it(`stops ${scoped ? "scoped" : "root"} appender stages after cancellation at ${stop} and rolls back`, async () => {
      const abort = new AbortController(),
        state = fixture(stop, abort);
      const append = (database: Parameters<typeof requireAdapterCapability>[0]) =>
        requireAdapterCapability(database, duckdbAppender).append(factory, [1], { signal: abort.signal });
      await strict.rejects(
        scoped ? state.database.transaction(append) : append(state.database),
        (error) => error instanceof QueryCancelledError,
      );
      const order = ["health1", "BEGIN", "health2", "initial", "CREATE", "appender", "append", "INSERT", "DROP"];
      strict.deepEqual(state.dispatched, [...order.slice(0, order.indexOf(stop) + 1), "ROLLBACK"]);
      strict.equal(state.dispatched.includes("COMMIT"), false);
      if (order.indexOf(stop) >= order.indexOf("appender")) strict.ok(state.cleaned.includes("appender"));
      await state.database.close();
    });
  }
}
await it("cancels root appender session attestation before BEGIN is sent", async () => {
  const abort = new AbortController(),
    state = fixture("health1", abort);
  await strict.rejects(
    requireAdapterCapability(state.database, duckdbAppender).append(factory, [1], { signal: abort.signal }),
    (error) => error instanceof QueryCancelledError,
  );
  strict.deepEqual(state.dispatched, ["health1"]);
  await state.database.close();
});
await it("does not start a root transaction if the row source cancels during first-row acquisition", async () => {
  const abort = new AbortController(),
    state = fixture("never", abort);
  async function* rows() {
    abort.abort();
    yield 1;
  }
  await strict.rejects(
    requireAdapterCapability(state.database, duckdbAppender).append(factory, rows(), { signal: abort.signal }),
    (error) => error instanceof QueryCancelledError,
  );
  strict.deepEqual(state.dispatched, []);
  await state.database.close();
});
