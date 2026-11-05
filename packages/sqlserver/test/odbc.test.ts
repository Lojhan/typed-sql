import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  adaptSqlServerOdbcConnection,
  createSqlServerOdbcDatabase,
  loadSqlServerOdbcDriver,
  type SqlServerOdbcConnection,
  type SqlServerOdbcDriver,
  type SqlServerOdbcQuery,
  sqlServerOdbc,
} from "../src/odbc.js";
import { sqlServerCatalogQueries } from "../src/provider.js";
import { sql, withQueryValuePlan } from "../src/query.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";
import { fixture } from "./helpers/catalog-fixture.js";
import { serverRow } from "./helpers/environment.js";

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
  const environment = { ...serverRow };
  const requested: string[] = [];
  let script: (q: NativeQuery, text?: string) => void = (q) => {
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
  const send = (prepared: boolean, values: readonly unknown[], text?: string) => {
    bindings.push([...values]);
    const q = new NativeQuery(prepared);
    queries.push(q);
    queueMicrotask(() => {
      const evidenceRow =
        text === sqlServerCatalogQueries.server
          ? environment
          : text === sqlServerCatalogQueries.options
            ? { "Set Option": "dateformat", Value: "mdy" }
            : undefined;
      if (evidenceRow) {
        q.emit(
          "meta",
          Object.keys(evidenceRow).map((name) => ({ name })),
        );
        q.emit("row", 0);
        Object.values(evidenceRow).forEach((value, index) => {
          q.emit("column", index, value);
        });
        q.emit("done");
        q.emit("free");
      } else if (text?.startsWith("SET QUOTED_IDENTIFIER")) {
        q.emit("done");
        q.emit("free");
      } else script(q, text);
    });
    return q;
  };
  const native: SqlServerOdbcConnection = {
    queryRaw(query, values) {
      strict.equal(query.numeric_string, true);
      requested.push(query.query_str);
      return send(false, values, query.query_str);
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
    environment,
    requested,
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
  await it("chooses exact raw transport for logically prepared arbitrary text before any dispatch", async () => {
    const state = setup(),
      text = "embedded\0data\0";
    state.script = (q) => {
      q.emit("meta", [{ name: "label", sqlType: "nvarchar" }]);
      q.emit("row", 0);
      q.emit("column", 0, q.prepared ? text.slice(0, -1) : text);
      q.emit("done");
      if (!q.prepared) q.emit("free");
    };
    const db = await createSqlServerOdbcDatabase({
      connection: state.native,
      driverImporter: async () => state.driver,
      driverVersion: "6.2.2",
    });
    const query = () =>
      withQueryValuePlan(sql<{ label: string }>`SELECT ${text} AS label`, {
        dialect: "sqlserver",
        typePolicyHash: calculateTypePolicyHash(defaultSqlServerTypePolicy),
        columns: [{ name: "label", type: "string", nullable: false, databaseType: "nvarchar(max)" }],
        parameters: [{ index: 1, type: "string", nullable: false, databaseType: "nvarchar(max)" }],
      });
    const find = db.prepare("exact-text", query);
    strict.deepEqual(await db.one(find()), { label: text });
    strict.deepEqual(await db.one(find()), { label: text });
    strict.equal(
      state.queries.some((q) => q.prepared),
      false,
    );
    strict.equal(state.requested.filter((sql) => sql.includes("AS label")).length, 2);
    await db.close();
  });

  await it("rejects unbounded legacy text plans before SELECT or DML OUTPUT can dispatch", async () => {
    const state = setup();
    const db = await createSqlServerOdbcDatabase({
      connection: state.native,
      driverImporter: async () => state.driver,
      driverVersion: "6.2.2",
    });
    const before = state.requested.length;
    for (const databaseType of ["varchar(max)", "text", "ntext"]) {
      const query = withQueryValuePlan(sql<{ label: string }>`DELETE FROM dbo.messages OUTPUT deleted.label`, {
        dialect: "sqlserver",
        typePolicyHash: calculateTypePolicyHash(defaultSqlServerTypePolicy),
        columns: [{ name: "label", type: "string", nullable: false, databaseType }],
        parameters: [],
      });
      await strict.rejects(() => db.all(query), /cannot preserve arbitrary/);
    }
    strict.equal(state.requested.length, before);
    await db.close();
  });
  await it("withholds unsupported raw metadata from buffered and streaming consumers", async () => {
    for (const metadata of [
      { name: "label", sqlType: "varchar", size: 0 },
      { name: "label", sqlType: "text" },
      { name: "label", sqlType: "varchar" },
    ]) {
      const state = setup();
      state.script = (q) => {
        q.emit("meta", [metadata]);
        if (q.cancelled) return;
        q.emit("row", 0);
        q.emit("column", 0, "corrupted");
        q.emit("done");
        q.emit("free");
      };
      const connection = adaptSqlServerOdbcConnection(state.driver, state.native);
      await strict.rejects(() => connection.execute("SELECT label"), /cannot preserve arbitrary/);
      const stream = connection.stream!("SELECT label", [], { batchSize: 1 });
      await strict.rejects(() => stream.next(), /cannot preserve arbitrary/);
      await stream.close();
    }
  });
  await it("allows bounded native VARCHAR metadata below the driver's LOB chunk threshold", async () => {
    const state = setup();
    state.script = (q) => {
      q.emit("meta", [{ name: "label", sqlType: "varchar", size: 8000 }]);
      q.emit("row", 0);
      q.emit("column", 0, "é\0");
      q.emit("done");
      q.emit("free");
    };
    strict.deepEqual((await adaptSqlServerOdbcConnection(state.driver, state.native).execute("SELECT label")).rows, [
      { label: "é\0" },
    ]);
  });

  await it("resolves the default SDK from the application rather than the grammar package", async () => {
    const directory = await mkdtemp(join(tmpdir(), "typed-sql-odbc-loader-")),
      cwd = process.cwd();
    try {
      const sdk = join(directory, "node_modules", "msnodesqlv8");
      await mkdir(sdk, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
      await writeFile(
        join(sdk, "package.json"),
        JSON.stringify({ name: "msnodesqlv8", version: "6.2.1", main: "index.cjs" }),
      );
      await writeFile(
        join(sdk, "index.cjs"),
        "module.exports={applicationOwned:true,promises:{open(){}},NVarChar(){},VarBinary(){},Double(){},Bit(){}}",
      );
      process.chdir(directory);
      const loaded = await loadSqlServerOdbcDriver();
      strict.equal((loaded as unknown as { applicationOwned: boolean }).applicationOwned, true);
      await strict.rejects(createSqlServerOdbcDatabase({ connectionString: "unused" }), /qualified/);
    } finally {
      process.chdir(cwd);
      await rm(directory, { recursive: true, force: true });
    }
  });

  await it("checks actual server evidence before mutation and validates injected SQL session settings", async () => {
    const future = setup();
    future.environment.version = "18.0.1.1";
    future.environment.compatibility_level = 180;
    await strict.rejects(
      createSqlServerOdbcDatabase({
        connection: future.native,
        driverImporter: async () => future.driver,
        driverVersion: "6.2.2",
        configureSession: true,
      }),
      /qualified boxed/,
    );
    strict.equal(
      future.requested.some((text) => text.startsWith("SET ")),
      false,
    );
    strict.equal(future.closes, 0);
    const invalid = setup();
    invalid.environment.arith_abort = 0;
    await strict.rejects(
      createSqlServerOdbcDatabase({
        connection: invalid.native,
        driverImporter: async () => invalid.driver,
        driverVersion: "6.2.2",
      }),
      /canonical/,
    );
    strict.equal(
      invalid.requested.some((text) => text.startsWith("SET ")),
      false,
    );
    const valid = setup(),
      db = await createSqlServerOdbcDatabase({
        connection: valid.native,
        driverImporter: async () => valid.driver,
        driverVersion: "6.2.2",
      });
    strict.equal(db.serverEvidence.version, "17.0.5035.5");
    strict.equal(Object.isFrozen(db.serverEvidence), true);
    await db.close();
  });

  await it("uses numeric strings, typed Unicode NULL and application-owned connection identity", async () => {
    const state = setup();
    const connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    strict.equal(adaptSqlServerOdbcConnection(state.driver, state.native), connection);
    await strict.rejects(connection.execute("SELECT ? AS id", [new Uint8Array()]), /typed hex/);
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
    const binary = state.bindings[0]?.[4] as { kind: string; value: unknown };
    strict.equal(Buffer.isBuffer(binary.value), true);
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
  await it("quarantines every entrypoint after a broken stream and frees prepared handles safely", async () => {
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    const handle = await connection.prepare!("SELECT 1");
    state.script = (q) => {
      q.emit("error", { sqlstate: "08S01" });
      q.emit("done");
      q.emit("free");
    };
    const stream = connection.stream!("SELECT 1", [], { batchSize: 1 });
    strict.equal(stream[Symbol.asyncIterator](), stream);
    await strict.rejects(() => stream.next());
    strict.equal(stream.connectionReusable, false);
    await stream.return!();
    await stream.close();
    await strict.rejects(() => connection.execute("SELECT 1"), /quarantined/);
    await strict.rejects(() => handle.execute([]), /quarantined/);
    await strict.rejects(() => connection.prepare!("SELECT 1"), /quarantined/);
    strict.throws(() => connection.stream!("SELECT 1", [], { batchSize: 1 }), /quarantined/);
    await handle.close();
  });
  await it("serializes physical prepared handles and propagates failed free without reusing the native session", async () => {
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    state.script = () => {};
    const handle = await connection.prepare!("SELECT ? AS id"),
      running = handle.execute(["1"]);
    await strict.rejects(() => handle.execute(["2"]), /busy/);
    await strict.rejects(() => handle.close(), /active/);
    const q = state.queries.at(-1)!;
    q.emit("done");
    await running;
    await handle.close();
    await strict.rejects(() => handle.execute([]), /closed/);
    const failed = setup();
    failed.native.prepare = (_query, callback) =>
      callback(null, {
        preparedQuery: () => new NativeQuery(true),
        getMeta: () => [],
        free: (callback) => callback(new Error("native free failed")),
      });
    const failedConnection = adaptSqlServerOdbcConnection(failed.driver, failed.native),
      failedHandle = await failedConnection.prepare!("SELECT 1");
    await strict.rejects(() => failedHandle.close(), /native free failed/);
    await strict.rejects(() => failedConnection.execute("SELECT 1"), /quarantined/);
  });
  await it("cancels in-flight raw and prepared requests and waits for terminal cleanup", async () => {
    for (const prepared of [false, true]) {
      const state = setup(),
        connection = adaptSqlServerOdbcConnection(state.driver, state.native),
        controller = new AbortController();
      state.script = () => {};
      const handle = prepared ? await connection.prepare!("SELECT 1") : undefined;
      const pending = handle
        ? handle.execute([], { signal: controller.signal })
        : connection.execute("SELECT 1", [], { signal: controller.signal });
      controller.abort("caller closed");
      await strict.rejects(pending, (error) => (error as { code?: unknown }).code === "TSQL_CANCELLED");
      strict.equal(state.queries[0]?.cancelled, 1);
      await handle?.close();
    }
    const state = setup(),
      connection = adaptSqlServerOdbcConnection(state.driver, state.native);
    state.script = () => {};
    const stream = connection.stream!("SELECT 1", [], { batchSize: 1 }),
      waiting = stream.next();
    await stream.return!();
    strict.deepEqual(await waiting, { done: true, value: undefined });
    strict.equal(state.queries[0]?.cancelled, 1);
  });
  await it("rejects malformed metadata, indexes and premature free while retaining harmless native info", async () => {
    for (const emit of [
      (q: NativeQuery) => q.emit("meta", {}),
      (q: NativeQuery) => {
        q.emit("meta", [{ name: "id" }]);
        q.emit("column", -1, 1);
      },
      (q: NativeQuery) => q.emit("free"),
    ]) {
      const state = setup();
      state.script = (q) => {
        emit(q);
        if (!q.listenerCount("free")) return;
        q.emit("done");
        q.emit("free");
      };
      await strict.rejects(() => adaptSqlServerOdbcConnection(state.driver, state.native).execute("SELECT 1"));
    }
    const state = setup();
    state.script = (q) => {
      q.emit("info", null);
      q.emit("info", { sqlstate: "01000", message: "notice" });
      q.emit("done");
      q.emit("free");
    };
    const result = await adaptSqlServerOdbcConnection(state.driver, state.native).execute("SELECT 1");
    strict.deepEqual(result.warnings, [{}, { code: "01000", message: "notice" }]);
  });
  await it("owns lazy explicit introspection loading and closes after catalog failures", async () => {
    const state = setup(),
      catalog = fixture();
    state.script = (q, text) => {
      const rows = catalog.data.get(text!);
      if (!rows) throw new Error("unexpected catalog query");
      const names = Object.keys(rows[0] ?? {});
      q.emit(
        "meta",
        names.map((name) => ({ name })),
      );
      for (const row of rows) {
        q.emit("row", 0);
        names.forEach((name, index) => {
          q.emit("column", index, row[name]);
        });
      }
      q.emit("done");
      q.emit("free");
    };
    const provider = sqlServerOdbc({
      connection: state.native,
      ownsConnection: true,
      driverImporter: async () => state.driver,
      driverVersion: "6.2.2",
      includeSchemas: ["dbo"],
      typePolicy: defaultSqlServerTypePolicy,
    });
    strict.equal(state.requested.length, 0);
    strict.equal((await provider.introspect({})).dialect, "sqlserver");
    strict.equal(state.closes, 1);
    const failed = setup();
    failed.script = (q) => {
      q.emit("error", new Error("catalog denied"));
      q.emit("done");
      q.emit("free");
    };
    await strict.rejects(
      () =>
        sqlServerOdbc({
          connection: failed.native,
          ownsConnection: true,
          driverImporter: async () => failed.driver,
          driverVersion: "6.2.2",
        }).introspect({}),
      /catalog denied/,
    );
    strict.equal(failed.closes, 1);
  });
  await it("rechecks actual default-adapter session facts before each typed request", async () => {
    const state = setup(),
      db = await createSqlServerOdbcDatabase({
        connection: state.native,
        driverImporter: async () => state.driver,
        driverVersion: "6.2.2",
      });
    const query = withQueryValuePlan(sql<{ id: bigint }>`SELECT ${1n} AS id`, {
      dialect: "sqlserver",
      typePolicyHash: calculateTypePolicyHash(defaultSqlServerTypePolicy),
      columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
      parameters: [{ index: 1, type: "bigint", nullable: false, databaseType: "bigint" }],
    });
    await db.one(query);
    const typedCount = state.requested.filter((text) => text.startsWith("SELECT (CONVERT")).length;
    state.environment.compatibility_level = 160;
    await strict.rejects(() => db.one(query), /evidence changed/);
    strict.equal(state.requested.filter((text) => text.startsWith("SELECT (CONVERT")).length, typedCount);
    await db.queryable.all("SET SHOWPLAN_XML OFF");
    state.environment.compatibility_level = 170;
    await db.one(query);
    await db.close();
  });
});
