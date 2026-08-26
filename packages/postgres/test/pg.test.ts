import { EventEmitter } from "node:events";
import type { Pool as PgPool } from "pg";
import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import { adaptPgPool, createPgDatabase, loadPgCursorDriver, loadPgDriver, type PgOptions, pg } from "../src/pg.js";
import type { PostgresQueryable, PostgresQueryResult } from "../src/provider.js";
import { createPostgresDatabase, type PostgresQueryConfig } from "../src/runtime.js";

class FakePgCursor {
  static readonly created: FakePgCursor[] = [];
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
  readonly config: unknown;
  closeCount = 0;
  readCount = 0;

  constructor(text: string, values?: readonly unknown[], config?: unknown) {
    this.text = text;
    this.values = values;
    this.config = config;
    FakePgCursor.created.push(this);
  }

  async read(): Promise<readonly Record<string, unknown>[]> {
    this.readCount += 1;
    return this.readCount === 1 ? [{ value: 1 }] : [];
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class CatalogClient implements PostgresQueryable {
  async query<Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> {
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("server_version")) rows = [{ server_version: "18.6" }];
    return { rows: rows as readonly Row[] };
  }
}

interface FakeNativeCursor {
  read(rowCount: number): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
}

class FakePgClient extends EventEmitter {
  pipeline = true;
  released = false;
  releaseError: Error | boolean | undefined;
  queryError: Error | undefined;
  readonly calls: unknown[] = [];
  query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> | FakeNativeCursor {
    this.calls.push(config);
    if (
      typeof config === "object" &&
      config !== null &&
      "read" in config &&
      typeof config.read === "function" &&
      "close" in config &&
      typeof config.close === "function"
    ) {
      return config as FakeNativeCursor;
    }
    if (this.queryError !== undefined) return Promise.reject(this.queryError);
    return Promise.resolve({ rows: [{ value: 1 }] });
  }
  release(error?: Error | boolean): void {
    this.released = true;
    this.releaseError = error;
  }
}

class FakePgPool {
  ended = false;
  readonly client = new FakePgClient();
  readonly calls: unknown[] = [];
  connectCount = 0;
  async query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(config);
    return { rows: [{ value: 1 }] };
  }
  async connect(): Promise<FakePgClient> {
    this.connectCount += 1;
    return this.client;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("application-owned pg integration", async () => {
  await it("rejects query_timeout exposed by an application-created pg pool", () => {
    const direct = Object.assign(new FakePgPool(), { options: { query_timeout: 100 } });
    strict.throws(() => adaptPgPool(direct as unknown as PgPool), /does not accept pg query_timeout/);

    for (const connectionString of [
      "postgresql://unused/app?query_timeout=100",
      "postgresql://unused/app?%71uery_timeout=100",
    ]) {
      const fromUri = Object.assign(new FakePgPool(), { options: { connectionString } });
      strict.throws(() => adaptPgPool(fromUri as unknown as PgPool), /does not accept pg query_timeout/);
    }
  });

  await it("rejects query_timeout from real pg Pool options before adapting it", async () => {
    const { Pool } = await loadPgDriver();
    const pools = [
      new Pool({ query_timeout: 100 }),
      new Pool({ connectionString: "postgresql://unused/app?query_timeout=100" }),
      new Pool({ connectionString: "postgresql://unused/app?%71uery_timeout=100" }),
    ];

    for (const pool of pools) {
      try {
        strict.throws(() => adaptPgPool(pool), /does not accept pg query_timeout.*statement_timeout/);
      } finally {
        await pool.end();
      }
    }
  });

  await it("adapts pool and checked-out client query shapes", async () => {
    const original = new FakePgPool();
    const pool = adaptPgPool(original as unknown as PgPool);
    strict.deepStrictEqual((await pool.query("SELECT 1")).rows, [{ value: 1 }]);
    const config: PostgresQueryConfig = {
      name: "selected-value",
      text: "SELECT $1",
      values: [1],
      types: { getTypeParser: () => String },
    };
    await pool.query(config);
    const client = await pool.connect();
    strict.strictEqual(client.pipeline, true);
    await client.query("SELECT 2");
    await client.query(config);
    client.release();
    await pool.end();
    strict.strictEqual(original.calls.length, 2);
    strict.strictEqual(original.client.calls.length, 2);
    strict.deepStrictEqual(original.calls[1], {
      name: "selected-value",
      text: "SELECT $1",
      values: [1],
      types: config.types,
    });
    strict.deepStrictEqual(original.client.calls[1], {
      name: "selected-value",
      text: "SELECT $1",
      values: [1],
      types: config.types,
    });
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.ended, true);
  });

  await it("discards a checked-out pg lease after a root batch query rejection", async () => {
    const original = new FakePgPool();
    const queryError = new Error("query rejected before readiness is known");
    original.client.queryError = queryError;
    const database = createPostgresDatabase({ pool: adaptPgPool(original as unknown as PgPool) });

    await strict.rejects(
      () => database.batch([sql`SELECT uncertain`]),
      (error) => {
        strict.strictEqual(error, queryError);
        return true;
      },
    );
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.client.releaseError, queryError);
  });

  await it("loads pg-cursor lazily and bridges its real rows-array API", async () => {
    FakePgCursor.created.length = 0;
    const original = new FakePgPool();
    let imports = 0;
    const pool = adaptPgPool(original as unknown as PgPool, async () => {
      imports += 1;
      return { default: FakePgCursor };
    });
    const database = createPostgresDatabase({ pool });
    const prepared = database.prepare("streamed-value", (value: bigint) => sql`SELECT ${value} AS value`);
    const stream = database.stream(prepared(7n), { batchSize: 4 });

    strict.strictEqual(imports, 0);
    strict.strictEqual(original.connectCount, 0);
    strict.deepStrictEqual(await stream.next(), { done: false, value: { value: 1 } });
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });

    strict.strictEqual(imports, 1);
    strict.strictEqual(original.connectCount, 1);
    strict.strictEqual(original.client.released, true);
    const cursor = FakePgCursor.created[0];
    strict.strictEqual(cursor?.text, "SELECT $1 AS value");
    strict.deepStrictEqual(cursor?.values, ["7"]);
    const cursorConfig = cursor?.config as { readonly types?: unknown };
    strict.ok(cursorConfig.types !== undefined);
    strict.deepStrictEqual(Object.keys(cursorConfig), ["types"]);
    strict.strictEqual(cursor?.closeCount, 1);
  });

  await it("discards the client with the primary cursor SQL error", async () => {
    const sqlError = new Error("invalid input syntax");
    let closeCount = 0;
    class SqlErrorCursor {
      async read(): Promise<readonly Record<string, unknown>[]> {
        throw sqlError;
      }
      async close(): Promise<void> {
        closeCount += 1;
      }
    }
    const original = new FakePgPool();
    const database = createPostgresDatabase({
      pool: adaptPgPool(original as unknown as PgPool, async () => ({ default: SqlErrorCursor })),
    });

    await strict.rejects(
      () => database.stream(sql`SELECT broken`).next(),
      (error) => {
        strict.strictEqual(error, sqlError);
        return true;
      },
    );
    strict.strictEqual(closeCount, 1);
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.client.releaseError, sqlError);
  });

  await it("settles a hanging native cursor close when the leased pg client fails fatally", async () => {
    const readError = new Error("cursor read failed");
    const fatalError = new Error("socket terminated");
    let signalCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    let closeCount = 0;
    class FatalCursor {
      async read(): Promise<readonly Record<string, unknown>[]> {
        throw readError;
      }
      close(): Promise<void> {
        closeCount += 1;
        signalCloseStarted();
        return new Promise(() => undefined);
      }
    }
    const original = new FakePgPool();
    const database = createPostgresDatabase({
      pool: adaptPgPool(original as unknown as PgPool, async () => ({ default: FatalCursor })),
    });
    const next = database.stream(sql`SELECT fatal`).next();

    await closeStarted;
    original.client.emit("error", fatalError);
    await strict.rejects(
      () => next,
      (error) => {
        strict.strictEqual(error, readError);
        return true;
      },
    );
    strict.strictEqual(closeCount, 1);
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.client.releaseError, readError);
    strict.strictEqual(original.client.listenerCount("error"), 0);
    strict.strictEqual(original.client.listenerCount("end"), 0);
  });

  await it("creates and owns a real pg pool without opening a connection", async () => {
    const database = await createPgDatabase({
      connectionString: async () => "postgresql://typed_sql:unused@127.0.0.1:1/unused",
      poolConfig: { max: 1, statement_timeout: 5_000 },
    });
    await database.close();
    await strict.rejects(() => createPgDatabase({ connectionString: "" }), /must not be empty/);
    await strict.rejects(
      () =>
        createPgDatabase({
          connectionString: "postgresql://unused/app",
          poolConfig: { types: {} } as never,
        }),
      /owns poolConfig\.types/,
    );
    await strict.rejects(
      () =>
        createPgDatabase({
          connectionString: "postgresql://unused/app",
          poolConfig: { query_timeout: 100 } as never,
        }),
      /does not accept pg query_timeout.*statement_timeout/,
    );
    for (const connectionString of [
      "postgresql://unused/app?query_timeout=100",
      "postgresql://unused/app?%71uery_timeout=100",
    ]) {
      await strict.rejects(() => createPgDatabase({ connectionString }), /does not accept pg query_timeout/);
    }
    await strict.rejects(
      () => createPgDatabase({ connectionString: async () => "postgresql://unused/app?%71uery_timeout=100" }),
      /does not accept pg query_timeout/,
    );

    const unsupportedClientTimeout = (): PgOptions => ({
      connectionString: "postgresql://unused/app",
      poolConfig: {
        // @ts-expect-error Client-side query_timeout can reject before ReadyForQuery.
        query_timeout: 100,
      },
    });
    void unsupportedClientTimeout;
  });

  await it("supports injected catalog clients and validates provider options", async () => {
    const snapshot = await pg({ client: new CatalogClient(), schemas: ["public"] }).introspect();
    strict.strictEqual(snapshot.version, "18.6");
    await strict.rejects(() => pg({}).introspect(), /requires connectionString or client/);
  });

  await it("normalizes missing application-owned pg failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(
      () =>
        loadPgDriver(async () => {
          throw missing;
        }),
      /pnpm add pg/,
    );
    const unexpected = new Error("loader exploded");
    await strict.rejects(
      () =>
        loadPgDriver(async () => {
          throw unexpected;
        }),
      unexpected,
    );
    strict.ok((await loadPgDriver()).Pool !== undefined);
  });

  await it("normalizes missing or invalid application-owned pg-cursor failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(
      () =>
        loadPgCursorDriver(async () => {
          throw missing;
        }),
      /pnpm add pg-cursor/,
    );
    await strict.rejects(() => loadPgCursorDriver(async () => ({ default: {} })), /default Cursor constructor/);
    strict.strictEqual(await loadPgCursorDriver(async () => ({ default: FakePgCursor })), FakePgCursor);
  });

  await it("does not lease a pg client when the lazy cursor dependency is missing", async () => {
    const original = new FakePgPool();
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    const database = createPostgresDatabase({
      pool: adaptPgPool(original as unknown as PgPool, async () => {
        throw missing;
      }),
    });
    const stream = database.stream(sql`SELECT 1`);
    strict.strictEqual(original.connectCount, 0);
    await strict.rejects(() => stream.next(), /pnpm add pg-cursor/);
    strict.strictEqual(original.connectCount, 0);
  });
});
