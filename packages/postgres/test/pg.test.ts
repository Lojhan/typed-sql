import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { Pool as PgPool } from "pg";
import { describe, it, strict } from "poku";
import { type DatabaseOperationEnd, requireAdapterCapability, sql } from "../../core/src/index.js";
import { postgresCopy } from "../src/index.js";
import {
  adaptPgPool,
  createPgDatabase,
  loadPgCopyStreams,
  loadPgCursorDriver,
  loadPgDriver,
  normalizePostgresAdapterError,
  type PgOptions,
  PostgresAdapterError,
  pg,
  readPgRuntimeServerEvidence,
  resolvePgRuntimeCodecs,
} from "../src/pg.js";
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
  readonly copyInput: Buffer[] = [];
  readonly copyStatements: string[] = [];
  query(
    config: unknown,
  ): Promise<{ rows: readonly Record<string, unknown>[] }> | FakeNativeCursor | Readable | Writable {
    this.calls.push(config);
    if (typeof config === "object" && config !== null && "copy" in config && "statement" in config) {
      const marker = config as { readonly copy: "from" | "to"; readonly statement: string };
      this.copyStatements.push(marker.statement);
      if (marker.copy === "to") {
        return marker.statement.includes("string")
          ? Readable.from(["1,one@example.com\n"])
          : Readable.from([Buffer.from("1,one@example.com\n")]);
      }
      return new Writable({
        write: (chunk, _encoding, callback) => {
          this.copyInput.push(Buffer.from(chunk));
          callback();
        },
      });
    }
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
  queryError: unknown;
  connectError: unknown;
  async query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(config);
    if (this.queryError !== undefined) throw this.queryError;
    return { rows: [{ value: 1 }] };
  }
  async connect(): Promise<FakePgClient> {
    this.connectCount += 1;
    if (this.connectError !== undefined) throw this.connectError;
    return this.client;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

class HangingPgClient extends EventEmitter {
  readonly calls: unknown[] = [];
  releaseCount = 0;
  releaseError: Error | boolean | undefined;
  #rejectQuery: ((error: unknown) => void) | undefined;

  query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(config);
    if (typeof config === "string") return Promise.resolve({ rows: [] });
    return new Promise((_resolve, reject) => {
      this.#rejectQuery = reject;
    });
  }

  release(error?: Error | boolean): void {
    this.releaseCount += 1;
    this.releaseError = error;
    if (error instanceof Error) this.#rejectQuery?.(error);
  }
}

class HangingPgPool {
  readonly client = new HangingPgClient();
  connectCount = 0;

  async query(): Promise<{ rows: readonly Record<string, unknown>[] }> {
    return { rows: [] };
  }

  async connect(): Promise<HangingPgClient> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {}
}

await describe("application-owned pg integration", async () => {
  await it("reads runtime evidence and resolves extension codecs to local OIDs", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const queryable = {
      async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
        calls.push({ text, ...(values === undefined ? {} : { values }) });
        const rows = text.includes("server_version")
          ? [
              {
                server_version: "18.6",
                standard_conforming_strings: "on",
                search_path: '"$user", public',
                extensions: ["vector:0.8.0"],
              },
            ]
          : [{ database_type: "vector", oid: 16_384, array_oid: 16_385 }];
        return { rows: rows as unknown as readonly Row[] };
      },
    };
    strict.deepStrictEqual(await readPgRuntimeServerEvidence(queryable), {
      product: "postgres",
      version: "18.6",
      versionKey: "18",
      features: ["vector:0.8.0"],
      settings: {
        searchPath: '"$user", public',
        standardConformingStrings: "on",
        visibilityScope: "current-role",
      },
    });
    const decode = (value: unknown) => String(value).slice(1, -1).split(",").map(Number);
    strict.deepStrictEqual(
      await resolvePgRuntimeCodecs(queryable, new Map([["vector", { databaseType: "vector", decode }]])),
      [{ oid: 16_384, arrayOid: 16_385, decode }],
    );
    strict.deepStrictEqual(calls[1]?.values, [["vector"]]);

    await strict.rejects(
      () =>
        resolvePgRuntimeCodecs(
          {
            async query<Row extends Record<string, unknown>>() {
              return {
                rows: [{ database_type: "vector", oid: null, array_oid: null }] as unknown as readonly Row[],
              };
            },
          },
          new Map([["vector", { databaseType: "vector", decode }]]),
        ),
      /TSQ407.*not visible at runtime/,
    );
    await strict.rejects(
      () =>
        readPgRuntimeServerEvidence({
          async query() {
            return { rows: [] };
          },
        }),
      /did not return server-version evidence/,
    );
  });

  await it("normalizes timeout, transaction-abort, connection-loss, and server failures", () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const aborted = Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    const lost = Object.assign(new Error("socket closed"), { code: "08006" });
    const server = Object.assign(new Error("unique violation"), { code: "23505" });
    for (const [source, kind, sqlState] of [
      [timeout, "timeout", "57014"],
      [aborted, "transaction-abort", "25P02"],
      [lost, "connection-loss", "08006"],
      [server, "server", "23505"],
    ] as const) {
      const error = normalizePostgresAdapterError(source);
      strict.ok(error instanceof PostgresAdapterError);
      strict.strictEqual(error.code, "POSTGRES_ADAPTER_ERROR");
      strict.strictEqual(error.kind, kind);
      strict.strictEqual(error.sqlState, sqlState);
      strict.strictEqual(error.cause, source);
      strict.strictEqual(normalizePostgresAdapterError(error), error);
    }
    strict.strictEqual(normalizePostgresAdapterError(new Error("driver failed")).kind, "driver");
    strict.strictEqual(normalizePostgresAdapterError("driver failed").message, "PostgreSQL driver operation failed");
    strict.strictEqual(
      normalizePostgresAdapterError(Object.assign(new Error("cancelled by user"), { code: "57014" })).kind,
      "server",
    );
    strict.strictEqual(
      normalizePostgresAdapterError(Object.assign(new Error("shutdown"), { code: "57P01" })).kind,
      "connection-loss",
    );
    strict.strictEqual(
      normalizePostgresAdapterError(Object.assign(new Error("socket"), { code: "ECONNRESET" })).kind,
      "connection-loss",
    );
  });

  await it("cancels an in-flight query by discarding its checked-out pg lease", async () => {
    const raw = new HangingPgPool();
    let completion: DatabaseOperationEnd | undefined;
    const database = createPostgresDatabase({
      pool: adaptPgPool(raw as unknown as PgPool),
      observer: { start: () => ({ end: (event) => (completion = event) }) },
    });
    const controller = new AbortController();
    const running = database.all(sql`SELECT pg_sleep(10)`, { signal: controller.signal });
    while (raw.client.calls.length === 0) await Promise.resolve();
    controller.abort("request closed");

    await strict.rejects(running, (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      strict.strictEqual((error as { reason?: unknown }).reason, "signal");
      strict.strictEqual((error as Error).cause, "request closed");
      return true;
    });
    strict.strictEqual(raw.connectCount, 1);
    strict.strictEqual(raw.client.releaseCount, 1);
    strict.ok(raw.client.releaseError instanceof Error);
    strict.strictEqual(completion?.status, "cancelled");
    strict.strictEqual(completion?.cancellationReason, "signal");
    strict.ok(!("cause" in completion!));
  });

  await it("rejects an already expired deadline without checking out a pg lease", async () => {
    const raw = new HangingPgPool();
    const database = createPostgresDatabase({ pool: adaptPgPool(raw as unknown as PgPool) });
    await strict.rejects(database.all(sql`SELECT pg_sleep(10)`, { deadline: Date.now() - 1 }), (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      strict.strictEqual((error as { reason?: unknown }).reason, "deadline");
      return true;
    });
    strict.strictEqual(raw.connectCount, 0);
  });

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
    strict.deepStrictEqual((await pool.query({ text: "SELECT 0" })).rows, [{ value: 1 }]);
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
    strict.strictEqual(original.client.calls.length, 3);
    strict.deepStrictEqual(original.client.calls[0], {
      name: "selected-value",
      text: "SELECT $1",
      values: [1],
      types: config.types,
    });
    strict.strictEqual(original.client.calls[1], "SELECT 2");
    strict.deepStrictEqual(original.client.calls[2], {
      name: "selected-value",
      text: "SELECT $1",
      values: [1],
      types: config.types,
    });
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.ended, true);
  });

  await it("normalizes pool, prepared-lease, and connection acquisition failures", async () => {
    const direct = new FakePgPool();
    const directError = Object.assign(new Error("server rejected"), { code: "22000" });
    direct.queryError = directError;
    await strict.rejects(
      () => adaptPgPool(direct as unknown as PgPool).query("SELECT broken"),
      (error: unknown) =>
        error instanceof PostgresAdapterError && error.kind === "server" && error.cause === directError,
    );

    const prepared = new FakePgPool();
    prepared.client.queryError = new Error("prepared failed");
    await strict.rejects(
      () => adaptPgPool(prepared as unknown as PgPool).query({ name: "broken", text: "SELECT broken" }),
      (error: unknown) => error instanceof PostgresAdapterError && error.cause === prepared.client.queryError,
    );
    strict.ok(prepared.client.releaseError instanceof PostgresAdapterError);

    const unavailable = new FakePgPool();
    unavailable.connectError = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
    const adapted = adaptPgPool(unavailable as unknown as PgPool);
    await strict.rejects(
      () => adapted.query({ name: "unavailable", text: "SELECT 1" }),
      (error: unknown) => error instanceof PostgresAdapterError && error.kind === "connection-loss",
    );
    await strict.rejects(
      () => adapted.connect(),
      (error: unknown) => error instanceof PostgresAdapterError && error.kind === "connection-loss",
    );
  });

  await it("bounds named statements per connection and invalidates them after session identity changes", async () => {
    const original = new FakePgPool();
    const pool = adaptPgPool(original as unknown as PgPool, undefined, undefined, { statementCacheSize: 1 });
    const first = await pool.connect();
    await first.query({ name: "first", text: "SELECT $1", values: [1] });
    await first.query({ name: "first", text: "SELECT $1", values: [2] });
    await first.query({ name: "second", text: "SELECT $1 + 1", values: [2] });
    first.release();
    strict.deepStrictEqual(original.client.calls.slice(0, 4), [
      { name: "first", text: "SELECT $1", values: [1] },
      { name: "first", text: "SELECT $1", values: [2] },
      'DEALLOCATE "first"',
      { name: "second", text: "SELECT $1 + 1", values: [2] },
    ]);

    await pool.query("/* migration */ CREATE TABLE cache_generation (id integer)");
    const second = await pool.connect();
    await second.query({ name: "third", text: "SELECT 3" });
    await second.query("SET LOCAL search_path = public");
    await second.query("SELECT 4");
    second.release();
    strict.deepStrictEqual(original.client.calls.slice(4), [
      "DEALLOCATE ALL",
      { name: "third", text: "SELECT 3" },
      "SET LOCAL search_path = public",
      "DEALLOCATE ALL",
      "SELECT 4",
    ]);
    strict.throws(
      () => adaptPgPool(new FakePgPool() as unknown as PgPool, undefined, undefined, { statementCacheSize: 0 }),
      /positive safe integer/,
    );
  });

  await it("discards a checked-out pg lease after a root batch query rejection", async () => {
    const original = new FakePgPool();
    const queryError = new Error("query rejected before readiness is known");
    original.client.queryError = queryError;
    const database = createPostgresDatabase({ pool: adaptPgPool(original as unknown as PgPool) });

    await strict.rejects(
      () => database.batch([sql`SELECT uncertain`]),
      (error) => {
        return error instanceof PostgresAdapterError && error.kind === "driver" && error.cause === queryError;
      },
    );
    strict.strictEqual(original.client.released, true);
    const releaseError = original.client.releaseError;
    if (!(releaseError instanceof PostgresAdapterError)) strict.fail("Expected a structured adapter error");
    strict.strictEqual(releaseError.cause, queryError);
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

  await it("bridges application-owned COPY streams and makes early export close successful", async () => {
    const original = new FakePgPool();
    let imports = 0;
    const pool = adaptPgPool(
      original as unknown as PgPool,
      async () => ({ default: FakePgCursor }),
      async () => {
        imports += 1;
        return {
          from: (statement: string) => ({ copy: "from", statement }),
          to: (statement: string) => ({ copy: "to", statement }),
        };
      },
    );
    await pool.ensureCopy!();
    const client = await pool.connect();
    const sink = await client.openCopyFrom!("COPY account FROM STDIN");
    await sink.write(new TextEncoder().encode("1\tone@example.com\n"));
    await sink.finish();
    strict.strictEqual(Buffer.concat(original.client.copyInput).toString("utf8"), "1\tone@example.com\n");

    const source = await client.openCopyTo!("COPY account TO STDOUT");
    strict.deepStrictEqual(await source.next(), {
      done: false,
      value: Buffer.from("1,one@example.com\n"),
    });
    await source.close();

    const completed = await client.openCopyTo!("COPY complete TO STDOUT");
    await completed.next();
    strict.deepStrictEqual(await completed.next(), { done: true, value: undefined });
    await completed.close();

    const returned = await client.openCopyTo!("COPY returned TO STDOUT");
    await returned.return!();
    const disposed = await client.openCopyTo!("COPY disposed TO STDOUT");
    await disposed[Symbol.asyncDispose]();
    const stringSource = await client.openCopyTo!("COPY string TO STDOUT");
    strict.deepStrictEqual((await stringSource.next()).value, Buffer.from("1,one@example.com\n"));
    await stringSource.close();

    const abortedSink = await client.openCopyFrom!("COPY aborted FROM STDIN");
    await abortedSink.abort("stop");
    strict.deepStrictEqual(original.client.copyStatements, [
      "COPY account FROM STDIN",
      "COPY account TO STDOUT",
      "COPY complete TO STDOUT",
      "COPY returned TO STDOUT",
      "COPY disposed TO STDOUT",
      "COPY string TO STDOUT",
      "COPY aborted FROM STDIN",
    ]);
    strict.strictEqual(imports, 1);
    client.release();
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

  await it("normalizes missing or invalid application-owned pg-copy-streams failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(
      () =>
        loadPgCopyStreams(async () => {
          throw missing;
        }),
      /pnpm add pg-copy-streams/,
    );
    await strict.rejects(() => loadPgCopyStreams(async () => ({ from: () => undefined })), /from\(\).*to\(\)/);
    const module = { from: () => ({}), to: () => ({}) };
    strict.strictEqual(await loadPgCopyStreams(async () => module), module);
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

  await it("does not lease a pg client when the lazy COPY dependency is missing", async () => {
    const original = new FakePgPool();
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    const database = createPostgresDatabase({
      pool: adaptPgPool(original as unknown as PgPool, undefined, async () => {
        throw missing;
      }),
    });
    const copy = requireAdapterCapability(database, postgresCopy);
    await strict.rejects(
      () => copy.copyFrom((id: bigint) => sql`INSERT INTO account (id) VALUES (${id})`, [1n]),
      /pnpm add pg-copy-streams/,
    );
    strict.strictEqual(original.connectCount, 0);
  });
});
