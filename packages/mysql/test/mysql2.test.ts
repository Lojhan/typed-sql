import { describe, it, strict } from "poku";
import type { Pool } from "mysql2/promise";
import { sql } from "../../core/src/index.js";
import { adaptMySql2Pool, createMySql2Database, loadMySql2Driver, mysql2 } from "../src/mysql2.js";
import type { MySqlQueryable, MySqlQueryResult } from "../src/provider.js";

class FakeRawConnection {
  released = false;
  readonly calls: string[] = [];
  async execute(sql: string): Promise<readonly [readonly Record<string, unknown>[], readonly { name: string; columnType: number }[]]> {
    this.calls.push(sql);
    return [[{ value: "1" }], [{ name: "value", columnType: 8 }]];
  }
  async query(sql: string): Promise<readonly [readonly Record<string, unknown>[], readonly never[]]> { this.calls.push(sql); return [[], []]; }
  async beginTransaction(): Promise<void> { this.calls.push("BEGIN"); }
  async commit(): Promise<void> { this.calls.push("COMMIT"); }
  async rollback(): Promise<void> { this.calls.push("ROLLBACK"); }
  release(): void { this.released = true; }
}

class FakeRawPool extends FakeRawConnection {
  ended = false;
  readonly connection = new FakeRawConnection();
  async getConnection(): Promise<FakeRawConnection> { return this.connection; }
  async end(): Promise<void> { this.ended = true; }
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
    strict.strictEqual(raw.connection.released, true);
    strict.strictEqual(raw.ended, true);
  });

  await it("creates and owns a mysql2 pool without opening a connection", async () => {
    const raw = new FakeRawPool();
    const database = await createMySql2Database({
      connectionUri: async () => "mysql://root:unused@127.0.0.1:1/unused",
      poolConfig: { connectionLimit: 2 },
      driverImporter: async () => fakeDriver(raw),
    });
    strict.deepStrictEqual(await database.execute(sql`SELECT ${1n}`), [{ value: 1n }]);
    await database.close();
    strict.strictEqual(raw.ended, true);
    await strict.rejects(() => createMySql2Database({ connectionUri: "" }), /must not be empty/);
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
        if (sql.includes("information_schema.COLUMNS")) return [[{
          schema_name: "app", table_name: "users", column_name: "id", database_type: "bigint", is_nullable: "NO", default_expression: null,
        }], []];
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
    await strict.rejects(() => loadMySql2Driver(async () => { throw missing; }), /pnpm add mysql2/);
    const unexpected = new Error("loader exploded");
    await strict.rejects(() => loadMySql2Driver(async () => { throw unexpected; }), unexpected);
    strict.ok((await loadMySql2Driver()).createPool !== undefined);
  });
});
