import * as sdk from "@duckdb/node-api";
import { it, strict } from "poku";
import { adaptDuckDBConnection, createNodeDuckDBDatabase, DuckDBAdapterError } from "../src/node-api.js";

const failure = new Error("metadata failure");
await it("closes newly created native handles if metadata construction fails", async () => {
  for (const stage of ["parameters", "prepared-columns", "result-columns"]) {
    const calls: string[] = [];
    const result = {
      returnType: sdk.ResultReturnType.QUERY_RESULT,
      columnCount: 1,
      columnName() {
        return "value";
      },
      columnType() {
        throw failure;
      },
      closeSync() {
        calls.push("result");
      },
      async getRows() {
        return [];
      },
    };
    const statement = {
      parameterCount: stage === "parameters" ? 1 : 0,
      parameterTypeId() {
        throw failure;
      },
      columnCount: stage === "prepared-columns" ? 1 : 0,
      columnTypeId() {
        return sdk.DuckDBTypeId.INTEGER;
      },
      columnName() {
        return "value";
      },
      columnType() {
        throw failure;
      },
      clearBindings() {},
      async run() {
        return result;
      },
      destroySync() {
        calls.push("statement");
      },
    };
    class Connection {
      async extractStatements() {
        return {
          count: 1,
          async prepare() {
            return statement;
          },
        };
      }
      interrupt() {}
      closeSync() {
        calls.push("connection");
      }
    }
    const connection = adaptDuckDBConnection(new Connection(), { ...sdk, DuckDBConnection: Connection });
    if (stage !== "result-columns") await strict.rejects(connection.prepare("SELECT 1"), (error) => error === failure);
    else {
      const prepared = await connection.prepare("SELECT 1");
      await strict.rejects(prepared.execute([]), (error) => error === failure);
      await prepared.close();
    }
    strict.deepEqual(calls, stage === "result-columns" ? ["result", "statement"] : ["statement"]);
  }
});
await it("quarantines native adapter state after metadata cleanup itself fails", async () => {
  let prepared = 0;
  class Connection {
    async extractStatements() {
      prepared++;
      return {
        count: 1,
        async prepare() {
          return {
            parameterCount: 0,
            columnCount: 1,
            columnTypeId() {
              return sdk.DuckDBTypeId.INTEGER;
            },
            columnName() {
              throw failure;
            },
            destroySync() {
              throw new Error("cleanup failed");
            },
          };
        },
      };
    }
    interrupt() {}
    closeSync() {}
  }
  const connection = adaptDuckDBConnection(new Connection(), { ...sdk, DuckDBConnection: Connection });
  await strict.rejects(connection.prepare("SELECT 1"), (error) => error === failure);
  await strict.rejects(connection.prepare("SELECT 2"), /unusable/u);
  strict.equal(prepared, 1);
});
await it("rejects malformed SDK capability objects and contradictory resource ownership", async () => {
  await strict.rejects(createNodeDuckDBDatabase({ connection: {}, path: "x" }), /Inject a DuckDB connection/u);
  await strict.rejects(createNodeDuckDBDatabase({ instance: {}, path: "x" }), /Injected DuckDB instance/u);
  await strict.rejects(
    createNodeDuckDBDatabase({ sdkImporter: async () => ({ ...sdk, DuckDBTypeId: null }) }),
    /metadata/u,
  );
  await strict.rejects(
    createNodeDuckDBDatabase({ sdkImporter: async () => ({ ...sdk, ResultReturnType: null }) }),
    /metadata/u,
  );
  await strict.rejects(createNodeDuckDBDatabase({ ownsConnection: false }), /Cannot own/u);
  const original = new Error("native module failed to initialize");
  await strict.rejects(
    createNodeDuckDBDatabase({
      sdkImporter: async () => {
        throw original;
      },
    }),
    (error) => error === original,
  );
});
await it("classifies genuine native syntax and constraint errors and then reuses the connection", async () => {
  strict.equal(sdk.version(), "v2.0.0");
  const database = await createNodeDuckDBDatabase();
  try {
    strict.deepEqual(await database.queryable.all("SELECT version() AS version"), [{ version: "v2.0.0" }]);
    await strict.rejects(
      database.queryable.all("SELECT missing"),
      (error) => error instanceof DuckDBAdapterError && error.kind === "syntax",
    );
    await database.queryable.all("CREATE TABLE failure_keys(id INTEGER PRIMARY KEY)");
    await database.queryable.all("INSERT INTO failure_keys VALUES(1)");
    await strict.rejects(
      database.queryable.all("INSERT INTO failure_keys VALUES(1)"),
      (error) => error instanceof DuckDBAdapterError && error.kind === "constraint",
    );
    strict.deepEqual(await database.queryable.all("SELECT count(*) AS count FROM failure_keys"), [{ count: 1n }]);
  } finally {
    await database.close();
  }
});
await it("rejects untrusted SDK metadata and classifies native protocol failures", async () => {
  const { duckDBTypeFromSDK } = await import("../src/node-api.js");
  for (const value of [undefined, null, {}, { typeId: "INTEGER" }])
    strict.throws(() => duckDBTypeFromSDK(value, sdk), /identifier/u);
  for (const imported of [
    null,
    1,
    {},
    { ...sdk, ENUM: undefined },
    { ...sdk, DuckDBTypeId: undefined },
    { ...sdk, ResultReturnType: false },
  ])
    await strict.rejects(createNodeDuckDBDatabase({ sdkImporter: async () => imported }), /SDK|metadata/u);
  for (const [message, kind] of [
    ["transactioncontext conflict", "conflict"],
    ["connection disconnected", "connection"],
    ["unexpected native error", "driver"],
  ] as const) {
    class Connection {
      async extractStatements() {
        throw new Error(message);
      }
      closeSync() {}
    }
    const connection = adaptDuckDBConnection(new Connection(), { ...sdk, DuckDBConnection: Connection });
    await strict.rejects(
      connection.prepare("SELECT 1"),
      (error) => error instanceof DuckDBAdapterError && error.kind === kind && error.cause instanceof Error,
    );
    await strict.rejects(connection.prepare("SELECT \0"), /NUL/u);
  }
});
await it("cleans up vector appenders on metadata faults and rejects unsafe chunk shapes", async () => {
  for (const stage of ["metadata", "append", "close"] as const) {
    let closes = 0,
      writes = 0;
    class Connection {
      async createAppender() {
        return {
          columnCount: 1,
          columnType() {
            if (stage === "metadata") throw failure;
            return sdk.INTEGER;
          },
          appendDataChunk() {
            writes++;
            if (stage === "append") throw failure;
          },
          closeSync() {
            closes++;
            if (stage === "close") throw failure;
          },
        };
      }
      async extractStatements() {
        throw new Error("should not prepare");
      }
      closeSync() {}
    }
    const connection = adaptDuckDBConnection(new Connection(), { ...sdk, DuckDBConnection: Connection });
    if (stage === "metadata") await strict.rejects(connection.createAppender!("stage"), (error) => error === failure);
    else {
      const appender = await connection.createAppender!("stage");
      for (const rows of [[], [[]], [[{ type: { kind: "scalar" as const, name: "VARCHAR" }, value: "bad" }]]])
        strict.throws(() => appender.append(rows), /shape/u);
      if (stage === "append")
        strict.throws(
          () => appender.append([[{ type: { kind: "scalar", name: "INTEGER" }, value: 1 }]]),
          (error) => error instanceof DuckDBAdapterError && error.kind === "driver",
        );
      else appender.append([[{ type: { kind: "scalar", name: "INTEGER" }, value: 1 }]]);
      if (stage === "close")
        strict.throws(
          () => appender.close(),
          (error) => error === failure,
        );
      else appender.close();
      appender.close();
      strict.throws(
        () => appender.append([[{ type: { kind: "scalar", name: "INTEGER" }, value: 1 }]]),
        /closed|unusable/u,
      );
      strict.equal(writes, 1);
      if (stage === "close") await strict.rejects(connection.prepare("SELECT 1"), /unusable/u);
    }
    strict.equal(closes, 1);
  }
  class Connection {}
  const unsupported = adaptDuckDBConnection(new Connection(), {
    ...sdk,
    DuckDBConnection: Connection,
    DuckDBDataChunk: undefined,
  });
  await strict.rejects(unsupported.createAppender!("stage"), /vector appender/u);
});

await it("stops private native health reads between statements when controls expire", async () => {
  for (const stopAfter of [0, 1, 2, 3]) {
    const abort = new AbortController();
    let reads = 0,
      closes = 0;
    class Connection {
      async run() {
        reads++;
        return {
          async getRows() {
            if (reads === stopAfter) abort.abort();
            return reads === 1 ? [["v2.0.0", "memory", "main"]] : [["integer_division", "false"]];
          },
          closeSync() {
            closes++;
          },
        };
      }
    }
    const connection = adaptDuckDBConnection(new Connection(), { ...sdk, DuckDBConnection: Connection });
    if (stopAfter === 0) abort.abort();
    await strict.rejects(connection.readServerEvidence!({ signal: abort.signal }), /cancelled/u);
    strict.equal(reads, stopAfter);
    strict.equal(closes, stopAfter, "Every completed health result must close before cancellation exits");
  }
  class NeverRun {
    async run() {
      throw new Error("must not dispatch expired health read");
    }
  }
  const connection = adaptDuckDBConnection(new NeverRun(), { ...sdk, DuckDBConnection: NeverRun });
  await strict.rejects(connection.readServerEvidence!({ deadline: Date.now() - 1 }), /deadline expired/u);
});
