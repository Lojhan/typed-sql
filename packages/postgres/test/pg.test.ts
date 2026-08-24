import { describe, it, strict } from "poku";
import type { Pool as PgPool } from "pg";
import { adaptPgPool, createPgDatabase, loadPgDriver, pg } from "../src/pg.js";
import type { PostgresQueryConfig } from "../src/runtime.js";
import type { PostgresQueryable, PostgresQueryResult } from "../src/provider.js";

class CatalogClient implements PostgresQueryable {
  async query<Row extends Record<string, unknown>>(text: string): Promise<PostgresQueryResult<Row>> {
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("server_version")) rows = [{ server_version: "18.6" }];
    return { rows: rows as readonly Row[] };
  }
}

class FakePgClient {
  released = false;
  readonly calls: unknown[] = [];
  async query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(config);
    return { rows: [{ value: 1 }] };
  }
  release(): void { this.released = true; }
}

class FakePgPool {
  ended = false;
  readonly client = new FakePgClient();
  readonly calls: unknown[] = [];
  async query(config: unknown): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push(config);
    return { rows: [{ value: 1 }] };
  }
  async connect(): Promise<FakePgClient> { return this.client; }
  async end(): Promise<void> { this.ended = true; }
}

await describe("application-owned pg integration", async () => {
  await it("adapts pool and checked-out client query shapes", async () => {
    const original = new FakePgPool();
    const pool = adaptPgPool(original as unknown as PgPool);
    strict.deepStrictEqual((await pool.query("SELECT 1")).rows, [{ value: 1 }]);
    const config: PostgresQueryConfig = { text: "SELECT $1", values: [1], types: { getTypeParser: () => String } };
    await pool.query(config);
    const client = await pool.connect();
    await client.query("SELECT 2");
    await client.query(config);
    client.release();
    await pool.end();
    strict.strictEqual(original.calls.length, 2);
    strict.strictEqual(original.client.calls.length, 2);
    strict.strictEqual(original.client.released, true);
    strict.strictEqual(original.ended, true);
  });

  await it("creates and owns a real pg pool without opening a connection", async () => {
    const database = await createPgDatabase({
      connectionString: async () => "postgresql://typed_sql:unused@127.0.0.1:1/unused",
      poolConfig: { max: 1 },
    });
    await database.close();
    await strict.rejects(
      () => createPgDatabase({ connectionString: "" }),
      /must not be empty/,
    );
  });

  await it("supports injected catalog clients and validates provider options", async () => {
    const snapshot = await pg({ client: new CatalogClient(), schemas: ["public"] }).introspect();
    strict.strictEqual(snapshot.version, "18.6");
    await strict.rejects(() => pg({}).introspect(), /requires connectionString or client/);
  });

  await it("normalizes missing application-owned pg failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" });
    await strict.rejects(() => loadPgDriver(async () => { throw missing; }), /pnpm add pg/);
    const unexpected = new Error("loader exploded");
    await strict.rejects(() => loadPgDriver(async () => { throw unexpected; }), unexpected);
    strict.ok((await loadPgDriver()).Pool !== undefined);
  });
});
