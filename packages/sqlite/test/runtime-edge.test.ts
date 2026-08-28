import { describe, it, strict } from "poku";
import { sql } from "../src/index.js";
import {
  adaptNodeSqliteDatabase,
  loadNodeSqlite,
  type NodeSqliteDatabaseLike,
  type NodeSqliteStatementLike,
  nodeSqlite,
} from "../src/node-sqlite.js";
import { createSqliteDatabase, type SqliteConnectionLike } from "../src/runtime.js";

function memoryConnection(rows: readonly Record<string, unknown>[] = []): SqliteConnectionLike & {
  readonly commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    all() {
      return rows;
    },
    exec(source) {
      commands.push(source);
    },
    iterate() {
      return rows;
    },
  };
}

await describe("SQLite runtime edge contracts", async () => {
  await it("enforces cardinality, capabilities, lifecycle, and connection shape", async () => {
    const empty = createSqliteDatabase({ connection: memoryConnection() });
    strict.deepStrictEqual(await empty.batch([]), []);
    strict.strictEqual(await empty.maybeOne(sql`SELECT 1 AS value`), undefined);
    await strict.rejects(empty.one(sql`SELECT 1 AS value`), /Expected exactly one row, received 0/);
    await strict.rejects(
      empty.all(sql`SELECT 1 AS value`, { deadline: Date.now() + 10 }),
      /does not support deadlines/,
    );
    await empty.close();
    await empty.close();
    await strict.rejects(empty.all(sql`SELECT 1 AS value`), /closed/);

    const multiple = createSqliteDatabase({ connection: memoryConnection([{ value: 1 }, { value: 2 }]) });
    await strict.rejects(multiple.maybeOne(sql`SELECT 1 AS value`), /Expected at most one row, received 2/);

    strict.throws(
      () =>
        createSqliteDatabase({
          connection: {
            all() {
              return [];
            },
            exec() {},
          } as unknown as SqliteConnectionLike,
        }),
      /all\(\), exec\(\), and iterate\(\)/,
    );
    strict.throws(
      () =>
        createSqliteDatabase({
          connection: {
            iterate() {
              return [];
            },
            exec() {},
          } as unknown as SqliteConnectionLike,
        }),
      /all\(\), exec\(\), and iterate\(\)/,
    );
  });

  await it("keeps streams exclusive, lazy, disposable, and failure-safe", async () => {
    const database = createSqliteDatabase({ connection: memoryConnection([{ value: 1 }, { value: 2 }]) });
    const stream = database.stream<{ value: number }, readonly []>(sql`SELECT 1 AS value`);
    strict.deepStrictEqual(await stream.next(), { done: false, value: { value: 1 } });
    await strict.rejects(database.all(sql`SELECT 2 AS value`), /while a SQLite query stream is active/);
    await strict.rejects(database.batch([sql`SELECT 2 AS value`]), /while a SQLite query stream is active/);
    await strict.rejects(
      database.transaction(async () => undefined),
      /while a SQLite query stream is active/,
    );
    strict.deepStrictEqual(await stream.return!(), { done: true, value: undefined });
    strict.deepStrictEqual(await stream.next(), { done: true, value: undefined });

    const thrown = database.stream(sql`SELECT 1 AS value`);
    await thrown.next();
    await strict.rejects(thrown.throw!(new Error("consumer stopped")), /consumer stopped/);

    const lazy = database.stream(sql`SELECT 1 AS value`);
    await database.close();
    await strict.rejects(lazy.next(), /closed/);

    const failing = createSqliteDatabase({
      connection: {
        ...memoryConnection(),
        iterate() {
          throw new Error("iterator failed");
        },
      },
    });
    await strict.rejects(failing.stream(sql`SELECT 1 AS value`).next(), /iterator failed/);
  });

  await it("enforces prepared-query identity and structure", async () => {
    const database = createSqliteDatabase({ connection: memoryConnection([{ value: 1 }]) });
    strict.throws(() => database.prepare("", () => sql`SELECT 1 AS value`), /non-empty/);
    strict.throws(() => database.prepare("bad\0name", () => sql`SELECT 1 AS value`), /cannot contain NUL/);
    database.prepare("duplicate", () => sql`SELECT 1 AS value`);
    strict.throws(() => database.prepare("duplicate", () => sql`SELECT 1 AS value`), /already registered/);

    const shared = sql`SELECT 1 AS value`;
    const first = database.prepare("first", () => shared);
    const second = database.prepare("second", () => shared);
    first();
    strict.throws(() => second(), /cannot use both prepared statement/);

    let expanded = false;
    const dynamic = database.prepare(
      "dynamic",
      () => sql`SELECT 1 AS value${expanded ? sql.fragment`, 2 AS other` : sql.empty}`,
    );
    dynamic();
    expanded = true;
    strict.throws(() => dynamic(), /must always render the same SQL text and structure/);

    const parameterized = database.prepare("parameterized", (value: number) => sql`SELECT ${value} AS value`);
    await database.one(parameterized(1));
    await database.one(parameterized(2));
  });

  await it("uses savepoints and closes transaction scopes", async () => {
    const connection = memoryConnection();
    const database = createSqliteDatabase({ connection });
    let escaped: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
    await database.transaction(async (transaction) => {
      escaped = transaction;
      await transaction.transaction(async () => undefined);
    });
    strict.deepStrictEqual(connection.commands, [
      "BEGIN",
      "SAVEPOINT typed_sql_2",
      "RELEASE SAVEPOINT typed_sql_2",
      "COMMIT",
    ]);
    await strict.rejects(escaped!.all(sql`SELECT 1 AS value`), /scope is closed/);
    const scopedClose = (escaped as unknown as { close(): Promise<void> }).close.bind(escaped);
    await strict.rejects(scopedClose(), /do not own connection lifecycle/);

    await strict.rejects(
      database.transaction(async (transaction) => {
        await transaction.transaction(async () => {
          throw new Error("nested failure");
        });
      }),
      /nested failure/,
    );
    strict.ok(connection.commands.includes("ROLLBACK TO SAVEPOINT typed_sql_2"));
    strict.ok(connection.commands.includes("ROLLBACK"));
    await strict.rejects(database.transaction(undefined as never), /callback must be a function/);
  });

  await it("adapts node:sqlite values, caching, import failures, and provider preconditions", async () => {
    const calls: unknown[][] = [];
    const readModes: boolean[] = [];
    let prepares = 0;
    const statement: NodeSqliteStatementLike = {
      all(...values) {
        calls.push([...values]);
        return [];
      },
      iterate(...values) {
        calls.push([...values]);
        return [][Symbol.iterator]();
      },
      setReadBigInts(enabled) {
        readModes.push(enabled);
      },
    };
    const native: NodeSqliteDatabaseLike = {
      prepare() {
        prepares += 1;
        return statement;
      },
      exec() {},
      close() {},
    };
    const connection = adaptNodeSqliteDatabase(native, {
      statementCacheSize: 1,
      typePolicy: { integer: "number", flexible: "union", unknown: "unknown" },
    });
    connection.all("SELECT ?", [true]);
    connection.all("SELECT ?", [false]);
    connection.iterate("SELECT ?", [new Uint8Array([1])]);
    connection.all("SELECT 2");
    connection.all("SELECT ?", [1, 1n, "one", null]);
    strict.strictEqual(prepares, 3);
    strict.deepStrictEqual(readModes, [false, false, false]);
    strict.deepStrictEqual(calls[0], [1n]);
    strict.deepStrictEqual(calls[1], [0n]);
    strict.throws(() => connection.all("SELECT ?", [undefined]), /cannot bind undefined/);
    strict.throws(() => connection.all("SELECT ?", [{}]), /cannot bind object/);

    const unavailable = Object.assign(new Error("missing"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
    await strict.rejects(
      loadNodeSqlite(async () => Promise.reject(unavailable)),
      /requires a Node.js release/,
    );
    await strict.rejects(
      loadNodeSqlite(async () => Promise.reject(new Error("loader failed"))),
      /loader failed/,
    );
    await strict.rejects(nodeSqlite({}).introspect(), /requires path or database/);
  });
});
