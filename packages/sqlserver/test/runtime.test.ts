import {
  type Database,
  QueryCardinalityError,
  QueryResultValidationError,
  type StandardSchemaV1,
  sql,
  withQueryValuePlan,
} from "@typed-sql/core";
import { calculateTypePolicyHash } from "@typed-sql/schema";
import { describe, it, strict } from "poku";
import {
  createSqlServerDatabase as createNativeDatabase,
  type SqlServerConnectionLike,
  type SqlServerDatabaseOptions,
  type SqlServerExecutionResult,
  type SqlServerProtocolStream,
  type SqlServerScope,
  validateSqlServerResultFields,
} from "../src/runtime.js";
import { defaultSqlServerTypePolicy } from "../src/type-policy.js";

import { serverEvidence } from "./helpers/environment.js";

const createSqlServerDatabase = (options: Omit<SqlServerDatabaseOptions, "serverEvidence">) =>
  createNativeDatabase({ ...options, serverEvidence });
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
  stream?: (
    sql: string,
    values: readonly unknown[],
    options: { readonly batchSize: number },
  ) => SqlServerProtocolStream;
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
  await it("binds empty and nonempty binary through one stable typed hex renderer", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const connection: SqlServerConnectionLike = {
      async execute(text, values = []) {
        calls.push({ text, values });
        return {
          rows: [{ bytes: values[0] === "" ? new Uint8Array() : Uint8Array.of(0, 255, 0) }],
          fields: [{ name: "bytes", databaseType: "varbinary" }],
        };
      },
    };
    const db = createSqlServerDatabase({ connection });
    const query = (value: Uint8Array) =>
      withQueryValuePlan(sql<{ bytes: Uint8Array }>`SELECT ${value} AS bytes`, {
        dialect: "sqlserver",
        typePolicyHash: hash,
        columns: [{ name: "bytes", type: "bytes", nullable: false, databaseType: "varbinary(max)" }],
        parameters: [{ index: 1, type: "bytes", nullable: false, databaseType: "varbinary(max)" }],
      });
    strict.deepEqual([...(await db.one(query(new Uint8Array()))).bytes], []);
    strict.deepEqual([...(await db.one(query(Uint8Array.of(0, 255, 0)))).bytes], [0, 255, 0]);
    strict.equal(calls[0]?.text, "SELECT (CONVERT(varbinary(max), ?, 2)) AS bytes");
    strict.equal(calls[1]?.text, calls[0]?.text);
    strict.deepEqual(
      calls.map((call) => call.values),
      [[""], ["00FF00"]],
    );
  });

  await it("lowers native TOP expressions while preserving string text and rejecting raw marker collisions", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    const query = withQueryValuePlan(
      sql<{ id: bigint }>`SELECT TOP (${2n}) id FROM orders WHERE N'@__typed_sql_1 ?' = N'@__typed_sql_1 ?'`,
      {
        dialect: "sqlserver",
        typePolicyHash: hash,
        columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
        parameters: [{ index: 1, type: "bigint", nullable: false, databaseType: "bigint" }],
      },
    );
    await db.all(query);
    strict.equal(
      connection.calls[0]?.sql,
      "SELECT TOP ((CONVERT(bigint, ?))) id FROM orders WHERE N'@__typed_sql_1 ?' = N'@__typed_sql_1 ?'",
    );
    const raw = withQueryValuePlan(sql`SELECT @__typed_sql_1 AS id`, {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
      parameters: [],
    });
    await strict.rejects(db.all(raw), /compiler-owned/);
    strict.equal(connection.calls.length, 1);
  });

  await it("provides complete transaction scopes, scoped atomic batches and stream ownership", async () => {
    const connection = new Connection();
    let closes = 0;
    connection.stream = () => ({
      fields: Promise.resolve([{ name: "id" }]),
      connectionReusable: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        return { done: false, value: { id: "5" } };
      },
      async close() {
        closes++;
      },
    });
    const db = createSqlServerDatabase({ connection });
    const neutral: Database<SqlServerScope> = db;
    strict.equal(neutral, db);
    let escaped: SqlServerScope | undefined;
    await db.transaction(async (scope) => {
      escaped = scope;
      const find = scope.prepare("scoped", id);
      const result = await scope.batch([find(1n), find(2n)] as const);
      strict.equal(result[1][0]?.id, 2n);
      await strict.rejects(
        scope.transaction(async () => {}),
        /Nested/,
      );
      const stream = scope.stream(id(5n));
      strict.equal((await stream.next()).value?.id, 5n);
      await strict.rejects(scope.all(id(6n)), /active stream/);
      await stream.close();
      strict.equal((await scope.one(id(6n))).id, 6n);
    });
    strict.equal(connection.calls.filter((call) => call.sql === "BEGIN TRANSACTION").length, 1);
    strict.equal(connection.commits, 1);
    strict.equal(closes, 1);
    await strict.rejects(escaped!.batch([id(7n)]), /retired/);
    strict.throws(() => escaped!.prepare("retired", id), /retired/);
    await strict.rejects(
      db.transaction(async (scope) => {
        await scope.stream(id(1n)).next();
      }),
      /in-flight/,
    );
    strict.equal(connection.rollbacks, 1);
    strict.equal(closes, 2);
    strict.equal((await db.one(id(8n))).id, 8n);
  });
  await it("retains prepared identity across validation wrappers and reports global stream validation indexes", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    const schema: StandardSchemaV1<unknown, { id: bigint }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate(value) {
          const row = value as { id: bigint };
          return row.id < 3n ? { value: row } : { issues: [{ message: "too large" }] };
        },
      },
    };
    const find = db.prepare("validated", id);
    await db.one(sql.validateResult(find(1n), schema));
    await db.one(sql.validateResult(find(2n), schema));
    strict.equal(connection.prepared, 1);
    let index = 0,
      closed = 0;
    connection.stream = () => ({
      fields: Promise.resolve([{ name: "id" }]),
      connectionReusable: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        index++;
        return { done: false, value: { id: String(index) } };
      },
      async close() {
        closed++;
      },
    });
    const stream = db.stream(sql.validateResult(id(1n), schema));
    strict.equal((await stream.next()).value?.id, 1n);
    strict.equal((await stream.next()).value?.id, 2n);
    await strict.rejects(stream.next(), (error) => error instanceof QueryResultValidationError && error.rowIndex === 2);
    strict.equal(closed, 1);
    await stream.close();
    strict.equal(closed, 1);
  });
  await it("closes during pending metadata without inventing a width mismatch", async () => {
    const connection = new Connection();
    let fields!: (value: readonly { name: string }[]) => void;
    let closes = 0;
    connection.stream = () => ({
      fields: new Promise((resolve) => {
        fields = resolve;
      }),
      connectionReusable: true,
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        throw new Error("must not fetch after close");
      },
      async close() {
        closes++;
        fields([]);
      },
    });
    const db = createSqlServerDatabase({ connection }),
      stream = db.stream(id(1n)),
      next = stream.next();
    await Promise.resolve();
    await Promise.resolve();
    await stream.close();
    strict.deepEqual(await next, { done: true, value: undefined });
    strict.equal(closes, 1);
    strict.equal((await db.one(id(2n))).id, 2n);
  });
  await it("reserves the connection while closing delayed prepared handles", async () => {
    const connection = new Connection();
    let release!: () => void;
    let freed = 0;
    connection.prepare = async (text) => ({
      execute: (values) => connection.execute(text, values),
      async close() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        freed++;
      },
    });
    const db = createSqlServerDatabase({ connection, ownsConnection: true }),
      sibling = createSqlServerDatabase({ connection });
    const find = db.prepare("closing", id);
    await db.one(find(1n));
    const closing = db.close(),
      second = db.close();
    await strict.rejects(db.all(id(2n)), /closed/);
    await strict.rejects(sibling.all(id(2n)), /leased/);
    strict.equal(connection.closed, 0);
    release();
    await Promise.all([closing, second]);
    strict.equal(freed, 1);
    strict.equal(connection.closed, 1);
    await strict.rejects(sibling.all(id(3n)), /unusable/);
  });

  await it("awaits application result validators after native decoding", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    let calls = 0;
    const schema: StandardSchemaV1<unknown, { id: bigint }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        async validate(value) {
          await Promise.resolve();
          calls++;
          const row = value as { id: unknown };
          return typeof row.id === "bigint"
            ? { value: { id: row.id + 1n } }
            : { issues: [{ message: "id must be bigint" }] };
        },
      },
    };
    strict.deepEqual(await db.one(sql.validateResult(id(1n), schema)), { id: 2n });
    strict.equal(calls, 1);
    await strict.rejects(
      db.transaction(async (scoped) => {
        void scoped.all(id(2n));
      }),
      /in-flight/,
    );
    strict.equal(connection.rollbacks, 1);
    strict.equal(connection.commits, 0);
  });

  await it("lowers only bound segments, copies native target evidence and preserves exact values", async () => {
    const connection = new Connection();
    const db = createSqlServerDatabase({ connection });
    strict.deepEqual(await db.one(id(9223372036854775807n)), { id: 9223372036854775807n });
    strict.equal(connection.calls[0]?.sql, "SELECT (CONVERT(bigint, ?)) AS id");
    strict.deepEqual(connection.calls[0]?.values, ["9223372036854775807"]);
    const text = "1234567890123456789012345678.1234567890";
    strict.deepEqual(await db.one(amount(text)), { amount: text });
    strict.equal(connection.calls[1]?.sql, "SELECT (CONVERT(decimal(38,10), ?)) AS amount");
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
      /in-flight|native execution failed/,
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
  await it("keeps execution aliases, scoped cardinality and stream disposal on the same owned connection", async () => {
    const connection = new Connection();
    let closed = 0;
    connection.stream = () => ({
      fields: Promise.resolve([{ name: "id" }]),
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        return { done: false, value: { id: "7" } };
      },
      async close() {
        closed++;
      },
    });
    const db = createSqlServerDatabase({ connection });
    strict.deepEqual(await db.execute(id(1n)), [{ id: 1n }]);
    strict.deepEqual(await db.maybeOne(id(2n)), { id: 2n });
    strict.deepEqual(await db.batch([]), []);
    await db.transaction(async (scope) => {
      strict.deepEqual(await scope.execute(id(3n)), [{ id: 3n }]);
      strict.deepEqual(await scope.one(id(4n)), { id: 4n });
      strict.deepEqual(await scope.maybeOne(id(5n)), { id: 5n });
      const stream = scope.stream(id(7n));
      strict.equal(stream[Symbol.asyncIterator](), stream);
      strict.deepEqual(await stream.next(), { done: false, value: { id: 7n } });
      strict.deepEqual(await stream.return!(), { done: true, value: undefined });
      const abandoned = scope.stream(id(7n));
      await abandoned[Symbol.asyncDispose]();
      const throwing = scope.stream(id(7n));
      await throwing.next();
      await strict.rejects(() => throwing.throw!(new Error("consumer stopped")), /consumer stopped/);
    });
    const root = db.stream(id(7n));
    strict.equal(root[Symbol.asyncIterator](), root);
    await root.next();
    await root[Symbol.asyncDispose]();
    const throwing = db.stream(id(7n));
    await throwing.next();
    await strict.rejects(() => throwing.throw!(new Error("root consumer stopped")), /root consumer stopped/);
    strict.equal(closed, 4);
    connection.rows = [];
    strict.equal(await db.maybeOne(id(1n)), undefined);
    await strict.rejects(() => db.one(id(1n)), QueryCardinalityError);
    connection.rows = [{ id: "1" }, { id: "2" }];
    await strict.rejects(() => db.maybeOne(id(1n)), QueryCardinalityError);
    await db.close();
  });
  await it("rejects unsupported streaming without leasing and propagates catalog result set errors", async () => {
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection });
    await strict.rejects(() => db.stream(id(1n)).next(), /protocol streaming/);
    strict.deepEqual(await db.one(id(1n)), { id: 1n });
    strict.deepEqual(await db.queryable.all("SELECT catalog", ["2"]), [{ id: "2" }]);
    connection.lateResults = 2;
    await strict.rejects(() => db.queryable.all("SELECT catalog"), /multiple result sets/);
    await db.close();
  });
  await it("checks native metadata families, modifiers, ordered names and row identities independently", async () => {
    for (const result of [
      { rows: [{ amount: "1.0000000000" }], fields: [] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "other" }] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "amount", databaseType: "int" }] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "amount", databaseType: "decimal(38,9)" }] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "amount", precision: 37 }] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "amount", scale: 9 }] },
      { rows: [{ amount: "1.0000000000" }], fields: [{ name: "amount", length: 10 }] },
      { rows: [{}], fields: [{ name: "amount" }] },
      { rows: [{ amount: "1.0000000000" }], warnings: [{ code: "01004" }] },
    ]) {
      const db = createSqlServerDatabase({
        connection: {
          async execute() {
            return result;
          },
        },
      });
      await strict.rejects(() => db.all(amount("1.0000000000")));
      await db.close();
    }
    for (const result of [
      { rows: [{ amount: "1.0000000000" }] },
      {
        rows: [{ amount: "1.0000000000" }],
        fields: [{ name: "amount", databaseType: "decimal(38,10)", precision: 38, scale: 10 }],
        warnings: [{ code: "01000" }],
      },
    ]) {
      const db = createSqlServerDatabase({
        connection: {
          async execute() {
            return result;
          },
        },
      });
      strict.deepEqual(await db.all(amount("1.0000000000")), [{ amount: "1.0000000000" }]);
      await db.close();
    }
  });
  await it("validates configuration and prepared codec bounds before native work", async () => {
    for (const options of [
      { preparedStatementLimit: 0 },
      { preparedCardinalityVariantLimit: -1 },
      { maximumPreparedValueBytes: NaN },
      { maximumPreparedValueBytes: 1.5 },
    ])
      strict.throws(
        () => createSqlServerDatabase({ connection: new Connection(), ...options }),
        /positive safe integer/,
      );
    strict.throws(
      () =>
        createSqlServerDatabase({
          connection: new Connection(),
          typePolicy: { ...defaultSqlServerTypePolicy, decimal: "Decimal" },
        }),
      /codecs/,
    );
    const connection = new Connection(),
      db = createSqlServerDatabase({ connection, maximumPreparedValueBytes: 2 });
    const find = db.prepare("small", id);
    await strict.rejects(() => db.all(find(123n)), /byte limit/);
    strict.equal(connection.calls.length, 0);
    await db.close();
    const bare = createSqlServerDatabase({
      connection: {
        async execute() {
          return { rows: [] };
        },
      },
    });
    const prepared = bare.prepare("requires-native", id);
    await strict.rejects(() => bare.all(prepared(1n)), /native prepared/);
    await bare.close();
  });
  await it("releases a failed cursor and quarantines native cleanup failures", async () => {
    for (const closeFails of [false, true]) {
      const connection = new Connection();
      connection.stream = () => ({
        fields: Promise.resolve([{ name: "id" }]),
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          throw new Error("cursor read failed");
        },
        async close() {
          if (closeFails) throw new Error("cursor cleanup failed");
        },
      });
      const db = createSqlServerDatabase({ connection });
      await strict.rejects(() => db.stream(id(1n)).next(), closeFails ? /cleanup failed/ : /read failed/);
      if (closeFails) await strict.rejects(() => db.all(id(1n)), /unusable/);
      else strict.deepEqual(await db.one(id(1n)), { id: 1n });
      await db.close();
    }
    const connection = new Connection();
    connection.close = async () => {
      throw new Error("connection close failed");
    };
    const db = createSqlServerDatabase({ connection, ownsConnection: true });
    await strict.rejects(() => db.close(), /connection close failed/);
    await strict.rejects(() => db.all(id(1n)), /closed/);
  });
  await it("validates available physical metadata before any ordinary typed DML can mutate", async () => {
    let executes = 0,
      closes = 0;
    const connection: SqlServerConnectionLike = {
      validatePreparedMetadata: true,
      async execute() {
        throw new Error("typed query bypassed metadata preparation");
      },
      async prepare() {
        return {
          fields: [{ name: "id", databaseType: "int" }],
          async execute() {
            executes++;
            return { rows: [{ id: "1" }] };
          },
          async close() {
            closes++;
          },
        };
      },
    };
    const db = createSqlServerDatabase({ connection });
    const mutation = withQueryValuePlan(sql<{ id: bigint }>`DELETE FROM dbo.messages OUTPUT deleted.id`, {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "id", type: "bigint", nullable: false, databaseType: "bigint" }],
      parameters: [],
    });
    await strict.rejects(() => db.all(mutation), /native result type/);
    strict.equal(executes, 0);
    strict.equal(closes, 1);
    connection.prepare = async () => ({
      fields: [{ name: "id", databaseType: "bigint" }],
      async execute() {
        executes++;
        return { rows: [{ id: "1" }] };
      },
      async close() {
        closes++;
      },
    });
    strict.deepEqual(await db.one(mutation), { id: 1n });
    strict.equal(executes, 1);
    strict.equal(closes, 2);
    await db.close();
  });
  await it("propagates controls through native preparation and closes an unused cancelled handle", async () => {
    const controller = new AbortController();
    let closes = 0,
      executes = 0;
    const db = createSqlServerDatabase({
      connection: {
        executionCapabilities: { cancellation: true, deadlines: true },
        validatePreparedMetadata: true,
        async execute() {
          throw new Error("raw execution dispatched");
        },
        async prepare(_text, controls) {
          strict.equal(controls?.signal, controller.signal);
          controller.abort("prepared before execution");
          return {
            async execute() {
              executes++;
              return { rows: [] };
            },
            async close() {
              closes++;
            },
          };
        },
      },
    });
    await strict.rejects(
      () => db.all(id(1n), { signal: controller.signal }),
      (error) => (error as { code?: unknown }).code === "TSQL_CANCELLED",
    );
    strict.equal(executes, 0);
    strict.equal(closes, 1);
    await db.close();
  });
  await it("preserves a metadata error if closing the rejected prepared handle also fails", async () => {
    const db = createSqlServerDatabase({
      connection: {
        validatePreparedMetadata: true,
        async execute() {
          return { rows: [] };
        },
        async prepare() {
          return {
            fields: [],
            async execute() {
              return { rows: [] };
            },
            async close() {
              throw new Error("cleanup failed");
            },
          };
        },
      },
    });
    await strict.rejects(() => db.all(id(1n)), /metadata width/);
    await strict.rejects(() => db.all(id(1n)), /unusable/);
    await db.close();
  });
  await it("qualifies native JSON's actual VARCHAR text wire without renaming its metadata", () => {
    const plan = {
      dialect: "sqlserver",
      typePolicyHash: hash,
      columns: [{ name: "value", type: "string" as const, nullable: false, databaseType: "json" }],
      parameters: [],
    };
    const fields = [
      {
        name: "value",
        databaseType: "varchar(max)",
        length: "max" as const,
        wireType: "odbc-varchar-unlimited-text" as const,
      },
    ];
    strict.throws(() => validateSqlServerResultFields(plan, fields), /native result type/);
    strict.doesNotThrow(() => validateSqlServerResultFields(plan, fields, true));
    strict.throws(
      () => validateSqlServerResultFields(plan, [{ name: "value", databaseType: "varchar(max)" }], true),
      /native result type/,
    );
  });
});
