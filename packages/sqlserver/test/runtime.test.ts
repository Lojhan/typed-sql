import { QueryCardinalityError, sql, withQueryValuePlan } from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  createSqlServerDatabase,
  type SqlServerConnectionLike,
  type SqlServerExecutionResult,
  type SqlServerScope,
} from "../src/runtime.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";

const hash = calculateTypePolicyHash(defaultSqlServerTypePolicy);
const id = (value: bigint) =>
  withQueryValuePlan(sql<{ id: bigint }>`SELECT ${value} AS id`, {
    dialect: "sqlserver",
    typePolicyHash: hash,
    columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
    parameters: [{ index: 1, type: "bigint", nullable: false, databaseType: "bigint" }],
  });
const amount = (value: string) =>
  withQueryValuePlan(sql<{ amount: string }>`SELECT ${value} AS amount`, {
    dialect: "sqlserver",
    typePolicyHash: hash,
    columns: [{ name: "amount", type: "string", nullable: false, databaseType: "decimal(38,10)" }],
    parameters: [{ index: 1, type: "string", nullable: false, databaseType: "decimal(38,10)" }],
  });
class Connection implements SqlServerConnectionLike {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  count = 0;
  commits = 0;
  rollbacks = 0;
  closed = 0;
  prepared = 0;
  freed = 0;
  failRollback = false;
  rows: readonly Record<string, unknown>[] | undefined;
  lateResults = 1;
  async execute(text: string, values: readonly unknown[] = []): Promise<SqlServerExecutionResult> {
    this.calls.push({ sql: text, values });
    if (text.startsWith("SELECT @@TRANCOUNT"))
      return { rows: [{ count: String(this.count), state: this.count ? "1" : "0" }] };
    if (text === "BEGIN TRANSACTION") {
      this.count = 1;
      return { rows: [] };
    }
    if (text === "COMMIT TRANSACTION") {
      this.commits++;
      this.count = 0;
      return { rows: [] };
    }
    if (text.startsWith("IF @@TRANCOUNT")) {
      if (this.failRollback) throw new Error("rollback failed");
      this.rollbacks++;
      this.count = 0;
      return { rows: [] };
    }
    if (values[0] === "13") throw new Error("native execution failed");
    const name = text.includes("AS amount") ? "amount" : "id";
    return { rows: this.rows ?? [{ [name]: values[0] }], fields: [{ name }], resultSets: this.lateResults };
  }
  async prepare(text: string) {
    this.prepared++;
    let closed = false;
    return {
      execute: (values: readonly unknown[]) => {
        if (closed) throw new Error("freed");
        return this.execute(text, values);
      },
      close: async () => {
        if (!closed) this.freed++;
        closed = true;
      },
    };
  }
  async close() {
    this.closed++;
  }
}
await describe("SQL Server exact runtime boundaries and leases", async () => {
  await it("lowers only bound segments, copies native target evidence and preserves exact values", async () => {
    const connection = new Connection();
    const db = createSqlServerDatabase({ connection });
    strict.deepEqual(await db.one(id(9223372036854775807n)), { id: 9223372036854775807n });
    strict.equal(connection.calls[0]?.sql, "SELECT CONVERT(bigint, ?) AS id");
    strict.deepEqual(connection.calls[0]?.values, ["9223372036854775807"]);
    const text = "1234567890123456789012345678.1234567890";
    strict.deepEqual(await db.one(amount(text)), { amount: text });
    strict.equal(connection.calls[1]?.sql, "SELECT CONVERT(decimal(38,10), ?) AS amount");
    await db.close();
    strict.equal(connection.closed, 0);
  });
  await it("rejects missing targets, wrong policy, range loss, raw SQL batches and controls before dispatch", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    const missing = withQueryValuePlan(sql`SELECT ${1n} AS id`, {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "id", type: "bigint", nullable: false }],
      parameters: [{ index: 1, type: "bigint", nullable: false }],
    });
    await strict.rejects(db.all(missing), /metadata/);
    await strict.rejects(db.all(id(1n << 63n)), /range/);
    await strict.rejects(db.all(amount("1.00000000001")), /rounding/);
    await strict.rejects(db.all(id(1n), { signal: new AbortController().signal }), /cancellation/);
    const batch = withQueryValuePlan(sql`SELECT ${1n} AS id; DELETE FROM users`, {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
      parameters: [{ index: 1, type: "bigint", nullable: false, databaseType: "bigint" }],
    });
    await strict.rejects(db.all(batch), /one complete/);
    strict.equal(connection.calls.length, 0);
  });
  await it("enforces cardinality, metadata/result sets and lossless decimal transport", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    connection.rows = [];
    strict.equal(await db.maybeOne(id(1n)), undefined);
    await strict.rejects(db.one(id(1n)), QueryCardinalityError);
    connection.rows = [{ id: "1" }, { id: "2" }];
    await strict.rejects(db.maybeOne(id(1n)), QueryCardinalityError);
    connection.rows = [{ amount: 1.123 }];
    await strict.rejects(db.one(amount("1")), /lossy/);
    connection.rows = undefined;
    connection.lateResults = 2;
    await strict.rejects(db.all(id(1n)), /result sets/);
  });
  await it("commits scoped requests and rejects root/second-wrapper operations during the callback", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection }),
      other = createSqlServerDatabase({ connection });
    let escaped: SqlServerScope | undefined;
    await db.transaction(async (scoped) => {
      escaped = scoped;
      await strict.rejects(db.all(id(1n)), /leased/);
      await strict.rejects(other.all(id(1n)), /leased/);
      strict.throws(() => createSqlServerDatabase({ connection }), /idle/);
      await strict.rejects(db.close(), /active/);
      const rows = await Promise.all([scoped.one(id(2n)), scoped.one(id(3n))]);
      strict.equal(rows[1]?.id, 3n);
    });
    strict.equal(connection.commits, 1);
    await strict.rejects(escaped!.all(id(1n)), /retired/);
  });
  await it("drains unawaited failures, rolls back atomic batches and quarantines failed cleanup", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    await strict.rejects(
      db.transaction(async (scoped) => {
        void scoped.all(id(13n));
      }),
      /native execution failed/,
    );
    strict.equal(connection.rollbacks, 1);
    await strict.rejects(db.batch([id(1n), id(13n)]), /native execution failed/);
    strict.equal(connection.rollbacks, 2);
    strict.equal(connection.commits, 0);
    strict.deepEqual(await db.batch([]), []);
    connection.failRollback = true;
    await strict.rejects(
      db.transaction(async (scoped) => {
        await scoped.all(id(13n));
      }),
      /native execution failed/,
    );
    await strict.rejects(db.all(id(1n)), /unusable/);
  });
  await it("does not roll back an application-owned transaction which was already active", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    connection.count = 1;
    await strict.rejects(
      db.transaction(async () => {}),
      /idle/,
    );
    strict.equal(connection.rollbacks, 0);
    strict.equal(connection.count, 1);
  });
  await it("reuses physical prepared statements by policy/target identity and frees owned handles", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection, ownsConnection: true });
    const find = db.prepare("find", id);
    strict.equal((await db.one(find(1n))).id, 1n);
    strict.equal((await db.one(find(2n))).id, 2n);
    strict.equal(connection.prepared, 1);
    await db.unprepare("find");
    strict.equal(connection.freed, 1);
    await db.close();
    await db.close();
    strict.equal(connection.closed, 1);
    await strict.rejects(db.all(id(1n)), /closed/);
  });
  await it("emits redacted observations without leaking SQL or values", async () => {
    const connection = new Connection();
    const events: unknown[] = [];
    const db = createSqlServerDatabase({
      connection,
      observer: {
        start(operation) {
          events.push(operation);
          return {
            end(event) {
              events.push(event);
            },
          };
        },
      },
    });
    await db.all(id(42n));
    const text = JSON.stringify(events);
    strict.ok(!text.includes("SELECT"));
    strict.ok(!text.includes('"values"'));
    strict.match(text, /sha256/);
  });
  await it("closes a pending stream before releasing its connection lease", async () => {
    const connection = new Connection();
    let finish!: (value: IteratorResult<Readonly<Record<string, unknown>>>) => void;
    let closed = 0;
    connection.stream = () => ({
      fields: Promise.resolve([{ name: "id" }]),
      connectionReusable: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      async close() {
        closed++;
        finish?.({ done: true, value: undefined });
      },
    });
    const db = createSqlServerDatabase({ connection });
    const stream = db.stream(id(1n));
    const pending = stream.next();
    await Promise.resolve();
    await Promise.resolve();
    await strict.rejects(db.all(id(2n)), /leased/);
    await stream.close();
    strict.deepEqual(await pending, { done: true, value: undefined });
    strict.equal(closed, 1);
    strict.equal((await db.one(id(2n))).id, 2n);
  });
});
