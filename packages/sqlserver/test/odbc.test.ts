import { EventEmitter } from "node:events";
import { describe, it, strict } from "poku";
import {
  adaptSqlServerOdbcConnection,
  createSqlServerOdbcDatabase,
  loadSqlServerOdbcDriver,
  type SqlServerOdbcConnection,
  type SqlServerOdbcDriver,
  type SqlServerOdbcQuery,
} from "../src/odbc.js";

class NativeQuery extends EventEmitter implements SqlServerOdbcQuery {
  constructor(readonly prepared = false) {
    super();
  }
  isPrepared() {
    return this.prepared;
  }
  cancelled = 0;
  paused = 0;
  resumed = 0;
  cancelQuery(callback?: (error?: unknown) => void) {
    this.cancelled++;
    callback?.();
    queueMicrotask(() => {
      this.emit("error", new Error("cancelled"));
      this.emit("done");
      this.emit("free");
    });
  }
  pauseQuery() {
    this.paused++;
  }
  resumeQuery() {
    this.resumed++;
  }
}
function setup() {
  let script: (q: NativeQuery) => void = (q) => {
    q.emit("meta", [{ name: "id" }]);
    q.emit("row", 0);
    q.emit("column", 0, "9223372036854775807");
    q.emit("done");
    if (!q.prepared) q.emit("free");
  };
  let close = 0,
    free = 0;
  const bindings: unknown[][] = [];
  const queries: NativeQuery[] = [];
  const configured: unknown[] = [];
  const send = (prepared: boolean, values: readonly unknown[]) => {
    bindings.push([...values]);
    const q = new NativeQuery(prepared);
    queries.push(q);
    queueMicrotask(() => script(q));
    return q;
  };
  const native: SqlServerOdbcConnection = {
    queryRaw(query, values) {
      strict.equal(query.numeric_string, true);
      return send(false, values);
    },
    prepare(query, callback) {
      strict.equal(query.numeric_string, true);
      callback(null, {
        preparedQuery: (values) => send(true, values),
        getMeta: () => [],
        free(callback) {
          free++;
          callback();
        },
      });
    },
    setUseUTC: (v) => configured.push(v),
    setUseNumericString: (v) => configured.push(v),
    setMaxPreparedColumnSize: (v) => configured.push(v),
    promises: {
      async close() {
        close++;
      },
    },
  };
  const driver: SqlServerOdbcDriver = {
    promises: {
      async open() {
        return native;
      },
    },
    NVarChar: (value) => ({ kind: "nvarchar", value }),
    VarBinary: (value) => ({ kind: "binary", value }),
    Double: (value) => ({ kind: "double", value }),
    Bit: (value) => ({ kind: "bit", value }),
  };
  return {
    native,
    driver,
    bindings,
    queries,
    configured,
    set script(next: typeof script) {
      script = next;
    },
    get closes() {
      return close;
    },
    get frees() {
      return free;
    },
  };
}
await describe("SQL Server explicit ODBC adapter", async () => {
  await it("uses numeric strings, typed Unicode NULL and application-owned connection identity", async () => {
    const state = setup();
    const connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    strict.equal(adaptSqlServerOdbcConnection(state.driver, state.native), connection);
    const result = await connection.execute("SELECT ? AS id", [
      null,
      "9223372036854775807",
      true,
      1,
      Uint8Array.of(0, 255),
    ]);
    strict.deepEqual(result.rows, [{ id: "9223372036854775807" }]);
    strict.deepEqual(state.bindings[0]?.slice(0, 4), [
      { kind: "nvarchar", value: null },
      { kind: "nvarchar", value: "9223372036854775807" },
      { kind: "bit", value: true },
      { kind: "double", value: 1 },
    ]);
    strict.throws(() => adaptSqlServerOdbcConnection({ ...state.driver }, state.native), /conflicting/);
  });
  await it("waits for complete native protocol and preserves late errors and truncation", async () => {
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    state.script = (q) => {
      q.emit("meta", [{ name: "id" }]);
      q.emit("row", 0);
      q.emit("column", 0, "1");
      q.emit("done");
      q.emit("error", new Error("late native failure"));
      q.emit("free");
    };
    await strict.rejects(connection.execute("SELECT 1 AS id"), /late native/);
    state.script = (q) => {
      q.emit("meta", [{ name: "id" }]);
      q.emit("info", { sqlstate: "01004", message: "truncated" });
      q.emit("done");
      q.emit("free");
    };
    await strict.rejects(connection.execute("SELECT 1 AS id"), /truncated/);
  });
  await it("rejects duplicate names, multiple result sets and broken transport", async () => {
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    state.script = (q) => {
      q.emit("meta", [{ name: "id" }, { name: "id" }]);
      q.emit("done");
      q.emit("free");
    };
    await strict.rejects(connection.execute("SELECT 1,2"), /unique/);
    state.script = (q) => {
      q.emit("meta", [{ name: "id" }]);
      q.emit("meta", [{ name: "next" }]);
      q.emit("done");
      q.emit("free");
    };
    await strict.rejects(connection.execute("SELECT 1;SELECT 2"), /multiple/);
    state.script = (q) => {
      q.emit("error", { sqlstate: "08S01", message: "connection lost" });
      q.emit("done");
      q.emit("free");
    };
    await strict.rejects(connection.execute("SELECT 1"));
    await strict.rejects(connection.execute("SELECT 1"), /quarantined/);
  });
  await it("frees prepared handles exactly once and keeps full native stream row identities", async () => {
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    const handle = await connection.prepare!("SELECT ? AS id");
    strict.equal((await handle.execute(["1"])).rows[0]?.id, "9223372036854775807");
    await handle.close();
    await handle.close();
    strict.equal(state.frees, 1);
    const stream = connection.stream!("SELECT 1 AS id", [], { batchSize: 1 });
    strict.deepEqual(await stream.next(), { done: false, value: { id: "9223372036854775807" } });
    strict.deepEqual(await stream.next(), { done: true, value: undefined });
    await stream.close();
  });
  await it("validates driver versions and configures exact transport with explicit ownership", async () => {
    const state = setup();
    strict.equal(await loadSqlServerOdbcDriver(async () => state.driver), state.driver);
    await strict.rejects(
      createSqlServerOdbcDatabase({
        connection: state.native,
        driverImporter: async () => state.driver,
        driverVersion: "6.2.1",
      }),
      /qualified/,
    );
    const db = await createSqlServerOdbcDatabase({
      connection: state.native,
      driverImporter: async () => state.driver,
      driverVersion: "6.2.2",
    });
    strict.deepEqual(state.configured, [true, true, 1048576]);
    await strict.rejects(
      createSqlServerOdbcDatabase({
        connection: state.native,
        driverImporter: async () => state.driver,
        driverVersion: "6.2.2",
        maximumPreparedValueBytes: 64,
      }),
      /conflicting/,
    );
    await db.close();
    strict.equal(state.closes, 0);
    const owned = await createSqlServerOdbcDatabase({
      connectionString: "Driver=explicit",
      driverImporter: async () => state.driver,
      driverVersion: "6.2.2",
    });
    await owned.close();
    strict.equal(state.closes, 1);
  });
});
