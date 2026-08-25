import { describe, it, strict } from "poku";
import { sql } from "../../core/src/index.js";
import {
  createPostgresDatabase,
  createPostgresTypeParsers,
  type PostgresClientLike,
  type PostgresPoolLike,
  type PostgresQueryConfig,
  type PostgresQueryResult,
} from "../src/runtime.js";

class MockClient implements PostgresClientLike {
  readonly calls: (PostgresQueryConfig | string)[] = [];
  released = false;
  failOnSelect = false;
  failOnRollback = false;

  async query(config: PostgresQueryConfig | string): Promise<PostgresQueryResult> {
    this.calls.push(config);
    if (this.failOnRollback && config === "ROLLBACK") throw new Error("rollback failed");
    if (this.failOnSelect && typeof config !== "string" && config.text.startsWith("SELECT"))
      throw new Error("query failed");
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
    strict.deepStrictEqual(defaults.getTypeParser(1016 as Parameters<typeof defaults.getTypeParser>[0])("{1,2,NULL}"), [
      1n,
      2n,
      null,
    ]);

    const numbers = createPostgresTypeParsers({ bigint: "number", numeric: "number", date: "string", json: "string" });
    strict.strictEqual(numbers.getTypeParser(1700)("12.5"), 12.5);
    strict.throws(() => numbers.getTypeParser(20)("9007199254740993"), /safe integer range/);
    strict.throws(() => numbers.getTypeParser(1700)("Infinity"), /finite number/);

    const strings = createPostgresTypeParsers({ bigint: "string", numeric: "string", date: "string", json: "string" });
    strict.strictEqual(strings.getTypeParser(20)("42"), "42");
    strict.strictEqual(strings.getTypeParser(1082)("2026-08-24"), "2026-08-24");
    strict.strictEqual(strings.getTypeParser(114)('{"ok":true}'), '{"ok":true}');
    strict.strictEqual(strings.getTypeParser(20, "binary")("raw"), "raw");
    strict.strictEqual(strings.getTypeParser(9999)("custom"), "custom");

    const native = {
      getTypeParser(oid: number, format = "text") {
        return (input: string) => ({ format, input, oid });
      },
    };
    const delegated = createPostgresTypeParsers(undefined, undefined, native);
    strict.deepStrictEqual(delegated.getTypeParser(23)("42"), { format: "text", input: "42", oid: 23 });
    strict.deepStrictEqual(delegated.getTypeParser(17, "binary")("raw"), { format: "binary", input: "raw", oid: 17 });
    strict.strictEqual(delegated.getTypeParser(20)("42"), 42n);

    const values = createPostgresTypeParsers(
      { bigint: "bigint", numeric: "Decimal", date: "Date", json: "unknown" },
      (value) => ({ decimal: value }),
    );
    strict.deepStrictEqual(values.getTypeParser(1700)("1.25"), { decimal: "1.25" });
    strict.ok(values.getTypeParser(1082)("2026-08-24") instanceof Date);
    strict.deepStrictEqual(values.getTypeParser(3802)('{"ok":true}'), { ok: true });
    strict.deepStrictEqual(values.getTypeParser(1016)("{{1,2},{3,NULL}}"), [
      [1n, 2n],
      [3n, null],
    ]);
    strict.deepStrictEqual(values.getTypeParser(199)('{"{\\"ok\\":true}",NULL}'), [{ ok: true }, null]);
    strict.throws(
      () => createPostgresTypeParsers({ bigint: "bigint", numeric: "Decimal", date: "Date", json: "unknown" }),
      /requires a decimal/,
    );
    strict.throws(() => defaults.getTypeParser(1016)("not-an-array"), /Invalid PostgreSQL array/);
    strict.throws(() => defaults.getTypeParser(1016)("{1,2"), /Unterminated PostgreSQL array/);
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
    const commands = pool.client.calls.map((call) => (typeof call === "string" ? call : call.text));
    strict.deepStrictEqual(commands, [
      "BEGIN",
      "SELECT id FROM users",
      "SAVEPOINT typed_sql_2",
      "SELECT id FROM users",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
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
    const commands = pool.client.calls.map((call) => (typeof call === "string" ? call : call.text));
    strict.deepStrictEqual(commands, ["BEGIN", "SELECT id FROM users", "ROLLBACK"]);
    strict.strictEqual(pool.client.released, true);
  });

  await it("rolls back nested savepoints and preserves outer rollback errors", async () => {
    const nestedPool = new MockPool();
    const nestedDb = createPostgresDatabase({ pool: nestedPool });
    await strict.rejects(
      () =>
        nestedDb.transaction(async (transaction) => {
          await transaction.transaction(async () => {
            throw new Error("nested failed");
          });
        }),
      /nested failed/,
    );
    strict.deepStrictEqual(
      nestedPool.client.calls.map((call) => (typeof call === "string" ? call : call.text)),
      ["BEGIN", "SAVEPOINT typed_sql_2", "ROLLBACK TO SAVEPOINT typed_sql_2", "ROLLBACK"],
    );

    const rollbackPool = new MockPool();
    rollbackPool.client.failOnSelect = true;
    rollbackPool.client.failOnRollback = true;
    const rollbackDb = createPostgresDatabase({ pool: rollbackPool });
    await strict.rejects(
      () => rollbackDb.transaction(async (transaction) => transaction.execute(sql`SELECT 1`)),
      /query failed/,
    );
  });

  await it("owns pools when requested and prevents transactional close", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool, ownsPool: true });
    await db.transaction(async (transaction) => {
      await strict.rejects(() => (transaction as typeof db).close(), /inside a transaction/);
    });
    await db.close();
    strict.strictEqual(pool.ended, true);
  });

  await it("encodes nested bigint array parameters", async () => {
    const pool = new MockPool();
    const db = createPostgresDatabase({ pool });
    await db.execute(sql`SELECT ${[1n, [2n]]}`);
    const call = pool.calls[0];
    if (call === undefined || typeof call === "string") strict.fail("Expected config");
    else strict.deepStrictEqual(call.values, [["1", ["2"]]]);
  });
});
