import { describe, it, strict } from "poku";
import {
  createPostgresDatabase,
  createPostgresTypeParsers,
  sql,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "../packages/runtime/src/index.js";

class MockClient implements PostgresClientLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  released = false;
  failOnSelect = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    if (this.failOnSelect && typeof config !== "string" && config.text.startsWith("SELECT")) throw new Error("query failed");
    return { rows: typeof config === "string" ? [] : [{ id: 1 }] };
  }

  release(): void {
    this.released = true;
  }
}

class MockPool implements PostgresPoolLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  readonly client = new MockClient();
  ended = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    return { rows: [{ id: 1 }] };
  }

  async connect(): Promise<PostgresClientLike> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

await describe("PostgreSQL runtime adapter", async () => {
  await it("uses policy-aware result codecs", () => {
    const defaults = createPostgresTypeParsers();
    strict.strictEqual(defaults.getTypeParser(20)("9007199254740993"), 9007199254740993n);
    strict.strictEqual(defaults.getTypeParser(1700)("12.50"), "12.50");
    strict.deepStrictEqual(defaults.getTypeParser(1016 as Parameters<typeof defaults.getTypeParser>[0])("{1,2,NULL}"), [1n, 2n, null]);

    const numbers = createPostgresTypeParsers({ bigint: "number", numeric: "number", date: "string", json: "string" });
    strict.strictEqual(numbers.getTypeParser(1700)("12.5"), 12.5);
    strict.throws(() => numbers.getTypeParser(20)("9007199254740993"), /safe integer range/);
  });

  await it("executes parameterized queries and encodes bigint inputs", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    const rows = await db.execute(sql<{ id: number }>`SELECT id FROM users WHERE id = ${7n}`);
    strict.deepStrictEqual(rows, [{ id: 1 }]);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected a query config call");
    else {
      strict.deepStrictEqual(call.values, ["7"]);
      strict.ok(call.types !== undefined);
    }
    await db.close();
    strict.strictEqual(pool.ended, false);
  });

  await it("commits on one checked-out client and supports nested savepoints", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT id FROM users`);
      await transaction.transaction(async (nested) => {
        await nested.execute(sql`SELECT id FROM users`);
      });
    });
    const commands = pool.client.calls.map((call) => typeof call === "string" ? call : call.text);
    strict.deepStrictEqual(commands, ["BEGIN", "SELECT id FROM users", "SAVEPOINT typed_sql_2", "SELECT id FROM users", "RELEASE SAVEPOINT typed_sql_2", "COMMIT"]);
    strict.strictEqual(pool.client.released, true);
  });

  await it("rolls back and releases the client after errors", async () => {
    const pool = new MockPool();
    pool.client.failOnSelect = true;
    const db = createPostgresDatabase({ pool });
    await strict.rejects(
      () => db.transaction(async (transaction) => transaction.execute(sql`SELECT id FROM users`)),
      /query failed/,
    );
    const commands = pool.client.calls.map((call) => typeof call === "string" ? call : call.text);
    strict.deepStrictEqual(commands, ["BEGIN", "SELECT id FROM users", "ROLLBACK"]);
    strict.strictEqual(pool.client.released, true);
  });
});
