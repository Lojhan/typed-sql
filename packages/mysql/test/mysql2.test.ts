import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { type DatabaseOperationEnd, sql } from "@typed-sql/core";
import type { Pool } from "mysql2/promise";
import { describe, it, strict } from "poku";
import { adaptMySql2Pool, createMySql2Database, loadMySql2Driver, mysql2 } from "../src/mysql2.js";
import type { MySqlQueryable, MySqlQueryResult } from "../src/provider.js";
import { createMySqlDatabase } from "../src/runtime.js";

class FakeCallbackCommand extends EventEmitter {
  readonly readable = new Readable({ objectMode: true, read() {} });
  highWaterMark: number | undefined;

  stream(options: { readonly highWaterMark?: number }): Readable {
    this.highWaterMark = options.highWaterMark;
    return this.readable;
  }
}

class FakeCallbackConnection extends EventEmitter {
  readonly commands: FakeCallbackCommand[] = [];
  readonly calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];

  execute(sql: string, values: readonly unknown[]): FakeCallbackCommand {
    const command = new FakeCallbackCommand();
    this.commands.push(command);
    this.calls.push({ sql, values });
    return command;
  }
}

class FakeRawConnection {
  readonly connection = new FakeCallbackConnection();
  released = false;
  readonly calls: string[] = [];
  executeCount = 0;
  queryCount = 0;
  async execute(sql: string): Promise<readonly [unknown, (readonly { name: string; columnType: number }[])?]> {
    this.executeCount += 1;
    this.calls.push(sql);
    if (sql.startsWith("UPDATE")) return [{ affectedRows: 1 }];
    return [[{ value: "1" }], [{ name: "value", columnType: 8 }]];
  }
  async query(sql: string): Promise<readonly [readonly Record<string, unknown>[], readonly never[]]> {
    this.queryCount += 1;
    this.calls.push(sql);
    return [[], []];
  }
  async beginTransaction(): Promise<void> {
    this.calls.push("BEGIN");
  }
  async commit(): Promise<void> {
    this.calls.push("COMMIT");
  }
  async rollback(): Promise<void> {
    this.calls.push("ROLLBACK");
  }
  release(): void {
    this.released = true;
  }
}

class FakeRawPool extends FakeRawConnection {
  ended = false;
  getConnectionCount = 0;
  readonly pooledConnection = new FakeRawConnection();
  async getConnection(): Promise<FakeRawConnection> {
    this.getConnectionCount += 1;
    return this.pooledConnection;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

class HangingRawConnection extends FakeRawConnection {
  destroyCount = 0;
  #rejectExecute: ((error: unknown) => void) | undefined;

  override execute(): Promise<readonly [unknown, (readonly { name: string; columnType: number }[])?]> {
    this.executeCount += 1;
    return new Promise((_resolve, reject) => {
      this.#rejectExecute = reject;
    });
  }

  destroy(): void {
    this.destroyCount += 1;
    this.#rejectExecute?.(new Error("connection destroyed"));
  }
}

class HangingRawPool extends FakeRawConnection {
  getConnectionCount = 0;
  readonly pooledConnection = new HangingRawConnection();

  async getConnection(): Promise<HangingRawConnection> {
    this.getConnectionCount += 1;
    return this.pooledConnection;
  }

  async end(): Promise<void> {}
}

class CatalogClient implements MySqlQueryable {
  async query<Row extends Record<string, unknown>>(sql: string): Promise<MySqlQueryResult<Row>> {
    let rows: readonly Record<string, unknown>[] = [];
    if (sql.includes("VERSION()")) rows = [{ server_version: "8.4.11" }];
    else if (sql.includes("DATABASE()")) rows = [{ database_name: "app" }];
    return { rows: rows as readonly Row[] };
  }
}

function fakeDriver(pool: FakeRawPool): typeof import("mysql2/promise") {
  return { createPool: () => pool } as unknown as typeof import("mysql2/promise");
}

await describe("application-owned mysql2 integration", async () => {
  await it("cancels an in-flight query by destroying its checked-out mysql2 connection", async () => {
    const raw = new HangingRawPool();
    let completion: DatabaseOperationEnd | undefined;
    const database = createMySqlDatabase({
      pool: adaptMySql2Pool(raw as unknown as Pool),
      observer: { start: () => ({ end: (event) => (completion = event) }) },
    });
    const controller = new AbortController();
    const running = database.all(sql`SELECT SLEEP(10)`, { signal: controller.signal });
    while (raw.pooledConnection.executeCount === 0) await Promise.resolve();
    controller.abort("request closed");

    await strict.rejects(running, (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      strict.strictEqual((error as { reason?: unknown }).reason, "signal");
      strict.strictEqual((error as Error).cause, "request closed");
      return true;
    });
    strict.strictEqual(raw.getConnectionCount, 1);
    strict.strictEqual(raw.pooledConnection.destroyCount, 1);
    strict.strictEqual(raw.pooledConnection.released, false);
    strict.strictEqual(completion?.status, "cancelled");
    strict.strictEqual(completion?.cancellationReason, "signal");
    strict.ok(!("cause" in completion!));
  });

  await it("rejects an already expired deadline without checking out a mysql2 connection", async () => {
    const raw = new HangingRawPool();
    const database = createMySqlDatabase({ pool: adaptMySql2Pool(raw as unknown as Pool) });
    await strict.rejects(database.all(sql`SELECT SLEEP(10)`, { deadline: Date.now() - 1 }), (error) => {
      strict.strictEqual((error as { code?: unknown }).code, "TSQL_CANCELLED");
      strict.strictEqual((error as { reason?: unknown }).reason, "deadline");
      return true;
    });
    strict.strictEqual(raw.getConnectionCount, 0);
  });

  await it("adapts mysql2 pool and connection result metadata", async () => {
    const raw = new FakeRawPool();
    const pool = adaptMySql2Pool(raw as unknown as Pool);
    const result = await pool.execute("SELECT ?", [1]);
    strict.deepStrictEqual(result.rows, [{ value: "1" }]);
    strict.strictEqual(result.fields?.[0]?.columnType, 8);
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute("SELECT 1");
    await connection.commit();
    connection.release();
    await pool.end();
    strict.strictEqual(raw.pooledConnection.released, true);
    strict.strictEqual(raw.ended, true);
  });

  await it("normalizes native mysql2 DML metadata in an ordered batch", async () => {
    const raw = new FakeRawPool();
    const database = createMySqlDatabase({ pool: adaptMySql2Pool(raw as unknown as Pool) });
    const results = await database.batch([
      sql<{ value: bigint }>`SELECT 1 AS value`,
      sql<never>`UPDATE accounts SET active = 1`,
    ]);
    strict.deepStrictEqual(results, [[{ value: 1n }], []]);
    strict.strictEqual(raw.getConnectionCount, 1);
    strict.strictEqual(raw.pooledConnection.released, true);
    strict.deepStrictEqual(raw.pooledConnection.calls, ["SELECT 1 AS value", "UPDATE accounts SET active = 1"]);
  });

  await it("creates and owns a mysql2 pool without opening a connection", async () => {
    const raw = new FakeRawPool();
    const database = await createMySql2Database({
      connectionUri: async () => "mysql://root:unused@127.0.0.1:1/unused",
      poolConfig: { connectionLimit: 2 },
      driverImporter: async () => fakeDriver(raw),
    });
    const prepared = database.prepare("select-value", (value: bigint) => sql`SELECT ${value}`);
    strict.strictEqual(raw.calls.length, 0);
    strict.strictEqual(raw.getConnectionCount, 0);
    strict.deepStrictEqual(await database.execute(prepared(1n)), [{ value: 1n }]);
    strict.strictEqual(raw.executeCount, 1);
    strict.strictEqual(raw.queryCount, 0);
    strict.strictEqual(raw.getConnectionCount, 0);
    await database.close();
    strict.strictEqual(raw.ended, true);
    await strict.rejects(() => createMySql2Database({ connectionUri: "" }), /must not be empty/);
  });

  await it("streams mysql2 execute protocol rows and waits for the command terminal event before reuse", async () => {
    const raw = new FakeRawPool();
    const pool = adaptMySql2Pool(raw as unknown as Pool);
    const connection = await pool.getConnection();
    const source = connection.stream!("SELECT ?", [1], { batchSize: 3 });
    const command = raw.pooledConnection.connection.commands[0]!;
    strict.strictEqual(command.highWaterMark, 3);
    strict.deepStrictEqual(raw.pooledConnection.connection.calls, [{ sql: "SELECT ?", values: [1] }]);

    command.emit("fields", [{ name: "value", columnType: 8 }]);
    command.readable.push({ value: "1" });
    command.readable.push(null);
    command.emit("end");
    strict.deepStrictEqual(await source.fields, [{ name: "value", columnType: 8 }]);
    strict.deepStrictEqual(await source.next(), { done: false, value: { value: "1" } });
    strict.deepStrictEqual(await source.next(), { done: true, value: undefined });
    await source.close();
    strict.strictEqual(source.connectionReusable, true);

    const draining = connection.stream!("SELECT many", [], { batchSize: 1 });
    const drainingCommand = raw.pooledConnection.connection.commands[1]!;
    let closed = false;
    const close = draining.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    strict.strictEqual(drainingCommand.readable.destroyed, true);
    strict.strictEqual(closed, false);
    drainingCommand.emit("end");
    await close;
    strict.strictEqual(closed, true);
    strict.strictEqual(draining.connectionReusable, true);
  });

  await it("preserves mysql2 protocol failures while making terminal cleanup awaitable", async () => {
    const raw = new FakeRawPool();
    const connection = await adaptMySql2Pool(raw as unknown as Pool).getConnection();
    const source = connection.stream!("SELECT broken", [], { batchSize: 2 });
    const command = raw.pooledConnection.connection.commands[0]!;
    const failure = new Error("mysql protocol failed");
    command.emit("error", failure);
    command.emit("end");
    await strict.rejects(() => source.fields, failure);
    await strict.rejects(() => source.close(), failure);
    strict.strictEqual(source.connectionReusable, true);
  });

  await it("normalizes mysql2 command metadata without fields for streamed DML", async () => {
    const raw = new FakeRawPool();
    const connection = await adaptMySql2Pool(raw as unknown as Pool).getConnection();
    const source = connection.stream!("UPDATE accounts SET active = 1", [], { batchSize: 2 });
    const command = raw.pooledConnection.connection.commands[0]!;
    command.emit("fields", undefined);
    command.emit("end");
    strict.deepStrictEqual(await source.fields, []);
    await source.close();
    strict.strictEqual(source.connectionReusable, true);
  });

  await it("settles fatal connection failures as non-reusable and handles early Readable errors", async () => {
    const raw = new FakeRawPool();
    const connection = await adaptMySql2Pool(raw as unknown as Pool).getConnection();
    const source = connection.stream!("SELECT disconnected", [], { batchSize: 2 });
    const command = raw.pooledConnection.connection.commands[0]!;
    const failure = new Error("connection lost");
    command.emit("fields", [{ name: "value", columnType: 8 }]);
    const next = source.next();
    raw.pooledConnection.connection.emit("error", failure);
    strict.deepStrictEqual(await source.fields, [{ name: "value", columnType: 8 }]);
    await strict.rejects(() => next, failure);
    await strict.rejects(() => source.close(), failure);
    strict.strictEqual(source.connectionReusable, false);
  });

  await it("rejects metadata and settles cleanup when a connection ends before fields", async () => {
    const raw = new FakeRawPool();
    const connection = await adaptMySql2Pool(raw as unknown as Pool).getConnection();
    const source = connection.stream!("SELECT interrupted", [], { batchSize: 2 });
    raw.pooledConnection.connection.emit("end");
    await strict.rejects(() => source.fields, /connection ended before.*completed/);
    await strict.rejects(() => source.close(), /connection ended before.*completed/);
    strict.strictEqual(source.connectionReusable, false);
  });

  await it("rejects mysql2 settings that would invalidate the runtime type policy", async () => {
    const raw = new FakeRawPool();
    const incompatible = [
      "supportBigNumbers",
      "bigNumberStrings",
      "decimalNumbers",
      "dateStrings",
      "jsonStrings",
      "typeCast",
      "rowsAsArray",
    ] as const;
    for (const option of incompatible) {
      await strict.rejects(
        () =>
          createMySql2Database({
            connectionUri: "mysql://unused/app",
            poolConfig: { [option]: true } as never,
            driverImporter: async () => fakeDriver(raw),
          }),
        new RegExp(`owns poolConfig\\.${option}`),
      );
    }
  });

  await it("supports injected catalog clients and validates provider options", async () => {
    const snapshot = await mysql2({ client: new CatalogClient(), schemas: ["app"] }).introspect();
    strict.strictEqual(snapshot.version, "8.4.11");
    await strict.rejects(() => mysql2({}).introspect(), /requires connectionUri or client/);
  });

  await it("introspects through an application-owned mysql2 driver and always closes its pool", async () => {
    class CatalogPool extends FakeRawPool {
      override async query(sql: string): Promise<readonly [readonly Record<string, unknown>[], readonly never[]]> {
        this.calls.push(sql);
        if (sql.includes("VERSION()")) return [[{ server_version: "8.4.11" }], []];
        if (sql.includes("DATABASE()")) return [[{ database_name: "app" }], []];
        if (sql.includes("information_schema.COLUMNS"))
          return [
            [
              {
                schema_name: "app",
                table_name: "users",
                column_name: "id",
                database_type: "bigint",
                is_nullable: "NO",
                default_expression: null,
              },
            ],
            [],
          ];
        if (sql.includes("information_schema.ROUTINES")) return [[], []];
        throw new Error("unexpected query");
      }
    }
    const raw = new CatalogPool();
    const snapshot = await mysql2({
      connectionUri: "mysql://unused/app",
      schemas: ["app"],
      driverImporter: async () => fakeDriver(raw),
    }).introspect();
    strict.strictEqual(snapshot.tables.users?.columns.id?.tsType, "bigint");
    strict.strictEqual(raw.ended, true);
  });

  await it("normalizes missing driver failures and preserves unexpected errors", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(
      () =>
        loadMySql2Driver(async () => {
          throw missing;
        }),
      /pnpm add mysql2/,
    );
    const unexpected = new Error("loader exploded");
    await strict.rejects(
      () =>
        loadMySql2Driver(async () => {
          throw unexpected;
        }),
      unexpected,
    );
    strict.ok((await loadMySql2Driver()).createPool !== undefined);
  });
});
