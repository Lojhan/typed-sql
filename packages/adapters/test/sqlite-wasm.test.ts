import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type QueryValuePlan, sql, withQueryValuePlan } from "@typed-sql/core";
import { describe, it, strict } from "poku";
import { SqliteSchemaProvider } from "../../sqlite/src/provider.js";
import { sqliteRenderer } from "../../sqlite/src/query.js";
import { createSqliteWasmDatabase, type SqliteWasmConnection, type SqliteWasmModule } from "../src/sqlite-wasm.js";

const sqlite3 = await sqlite3InitModule();
// Compile-time compatibility with the actual official driver, not only test doubles.
const module: SqliteWasmModule = sqlite3;
const options = {
  renderer: sqliteRenderer,
  profile: { id: "sqlite-wasm", dialect: "sqlite", integer: "lossless", jsonWire: "text", typePolicyHash: "wasm-test" },
} as const;
function query<Row = Record<string, unknown>>(text: string, columns: QueryValuePlan["columns"] = []) {
  return withQueryValuePlan(sql<Row>`${sql.raw(text)}`, {
    dialect: "sqlite",
    typePolicyHash: "wasm-test",
    columns,
    parameters: [],
  });
}
const count = query<{ n: bigint }>("SELECT count(*) AS n FROM items", [{ name: "n", type: "bigint", nullable: false }]);
await describe("official SQLite Wasm OO1 adapter", async () => {
  await it("preserves INTEGER storage, REAL storage, bytes, nulls and evidence without unsafe integer recovery", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const contract: SqliteWasmConnection = connection;
    const database = createSqliteWasmDatabase(module, contract, options);
    try {
      strict.equal(database.evidence.libraryVersion, "3.54.1");
      strict.ok(database.evidence.compileOptions.length > 0);
      strict.equal(typeof database.evidence.vfs, "string");
      const row = await database.one(
        query<{ small: bigint; max: bigint; min: bigint; real: number; bytes: Uint8Array; empty: null }>(
          "SELECT 7 AS small, 9223372036854775807 AS max, -9223372036854775808 AS min, CAST(7 AS REAL) AS real, X'00ff' AS bytes, NULL AS empty",
          [
            { name: "small", type: "bigint", nullable: false },
            { name: "max", type: "bigint", nullable: false },
            { name: "min", type: "bigint", nullable: false },
            { name: "real", type: "number", nullable: false },
            { name: "bytes", type: "bytes", nullable: false },
            { name: "empty", type: "unknown", nullable: true },
          ],
        ),
      );
      strict.deepEqual(row, {
        small: 7n,
        max: 9223372036854775807n,
        min: -9223372036854775808n,
        real: 7,
        bytes: Uint8Array.of(0, 255),
        empty: null,
      });
      await database.all(
        query("SELECT randomblob(1024) AS bytes", [{ name: "bytes", type: "bytes", nullable: false }]),
      );
      strict.deepEqual(row.bytes, Uint8Array.of(0, 255));
      strict.equal(connection.openStatementCount(), 0);
      await strict.rejects(
        database.one(query("SELECT CAST(7 AS REAL) AS n", [{ name: "n", type: "bigint", nullable: false }])),
        /expected bigint/u,
      );
      strict.equal(
        (await database.one(query<{ n: number }>("SELECT 7 AS n", [{ name: "n", type: "number", nullable: false }]))).n,
        7,
      );
      await strict.rejects(
        database.one(query("SELECT 9223372036854775807 AS n", [{ name: "n", type: "number", nullable: false }])),
        /precision/u,
      );
      strict.equal(connection.openStatementCount(), 0);
    } finally {
      await database.close();
      connection.close();
    }
  });

  await it("binds values, JSON and binary documents while rejecting incompatible transport and controls", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const database = createSqliteWasmDatabase(module, connection, options);
    try {
      const text = "Ada'; DROP TABLE users; --";
      const input = withQueryValuePlan(
        sql`SELECT ${9223372036854775807n} AS id, ${text} AS name, ${Uint8Array.of(255)} AS bytes, ${true} AS yes`,
        {
          dialect: "sqlite",
          typePolicyHash: "wasm-test",
          columns: [
            { name: "id", type: "bigint", nullable: false },
            { name: "name", type: "string", nullable: false },
            { name: "bytes", type: "bytes", nullable: false },
            { name: "yes", type: "bigint", nullable: false },
          ],
          parameters: [
            { index: 1, type: "bigint", nullable: false },
            { index: 2, type: "string", nullable: false },
            { index: 3, type: "bytes", nullable: false },
            { index: 4, type: "boolean", nullable: false },
          ],
        },
      );
      strict.deepEqual(await database.one(input), {
        id: 9223372036854775807n,
        name: text,
        bytes: Uint8Array.of(255),
        yes: 1n,
      });
      const document = withQueryValuePlan(sql`SELECT ${sql.json({ source: "wasm", ids: [1, 2] })} AS doc`, {
        dialect: "sqlite",
        typePolicyHash: "wasm-test",
        columns: [
          {
            name: "doc",
            type: "unknown",
            nullable: false,
            json: { shape: { kind: "unknown" }, representation: "parsed" },
          },
        ],
        parameters: [
          {
            index: 1,
            type: "unknown",
            nullable: false,
            json: { shape: { kind: "unknown" }, representation: "parsed" },
          },
        ],
      });
      strict.deepEqual(await database.one(document), { doc: { source: "wasm", ids: [1, 2] } });
      strict.ok(
        (
          await database.one(
            query<{ doc: Uint8Array }>("SELECT jsonb('{}') AS doc", [
              {
                name: "doc",
                type: "bytes",
                nullable: false,
                json: { shape: { kind: "unknown" }, representation: "binary" },
              },
            ]),
          )
        ).doc instanceof Uint8Array,
      );
      await strict.rejects(database.all(query("SELECT 1"), { signal: new AbortController().signal }), /cancellation/u);
      await strict.rejects(database.all(query("SELECT 1"), { deadline: Date.now() + 1000 }), /deadline/u);
      await strict.rejects(database.all(sql`SELECT ${1}`), /compiled query value plan/u);
      strict.throws(
        () =>
          createSqliteWasmDatabase(module, connection, {
            ...options,
            profile: { ...options.profile, integer: "safe-number" },
          }),
        /lossless/u,
      );
      strict.throws(
        () =>
          createSqliteWasmDatabase(module, connection, {
            ...options,
            profile: { ...options.profile, jsonWire: "parsed" },
          }),
        /text JSON/u,
      );
      strict.throws(
        () => createSqliteWasmDatabase({ ...module, config: { bigIntEnabled: false } }, connection, options),
        /BigInt/u,
      );
    } finally {
      await database.close();
      connection.close();
    }
  });

  await it("rejects multi-statement SQL and invalid inputs before stepping and always finalizes statements", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const database = createSqliteWasmDatabase(module, connection, options);
    try {
      await database.all(query("CREATE TABLE items (id INTEGER PRIMARY KEY) STRICT"));
      for (const text of [
        "INSERT INTO items VALUES (1); INSERT INTO items VALUES (2)",
        "INSERT INTO items VALUES (1); invalid SQL",
        "SELECT 1 AS n, 2 AS n",
        "SELECT ? AS n",
        "SELECT 1\0; INSERT INTO items VALUES (1)",
      ]) {
        await strict.rejects(database.all(query(text)));
        strict.equal(connection.openStatementCount(), 0);
      }
      strict.equal((await database.one(count)).n, 0n);
      const one = query<{ n: bigint }>("SELECT 1 AS n; -- trailing comment\n/* ; ? */", [
        { name: "n", type: "bigint", nullable: false },
      ]);
      strict.equal((await database.one(one)).n, 1n);
      strict.equal(
        (
          await database.one(
            query<{ n: string }>("SELECT '; ? --' AS n", [{ name: "n", type: "string", nullable: false }]),
          )
        ).n,
        "; ? --",
      );
      for (const value of [
        9223372036854775808n,
        -9223372036854775809n,
        Number.MAX_SAFE_INTEGER + 1,
        Infinity,
        NaN,
        undefined,
        {},
        new Date(),
      ])
        await strict.rejects(database.queryable.all("INSERT INTO items VALUES (?)", [value]));
      strict.equal((await database.one(count)).n, 0n);
      strict.equal(connection.openStatementCount(), 0);
    } finally {
      await database.close();
      connection.close();
    }
  });

  await it("shares a transaction lease, rolls back atomic batches, drains failures and retires callback scopes", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const database = createSqliteWasmDatabase(module, connection, options);
    const second = createSqliteWasmDatabase(module, connection, options);
    try {
      await database.all(query("CREATE TABLE items (id INTEGER PRIMARY KEY) STRICT"));
      await strict.rejects(
        database.batch([query("INSERT INTO items VALUES (1)"), query("INSERT INTO items VALUES (1)")]),
      );
      strict.equal((await database.one(count)).n, 0n);
      await database.transaction(async (scope) => {
        await strict.rejects(database.all(count), /active transaction/u);
        await strict.rejects(second.queryable.all("SELECT 1"), /active transaction/u);
        await strict.rejects(database.close(), /active transaction/u);
        await strict.rejects(
          second.transaction(async () => {}),
          /active transaction/u,
        );
        await scope.all(query("INSERT INTO items VALUES (1)"));
      });
      strict.equal((await database.one(count)).n, 1n);
      await strict.rejects(
        database.transaction(async (scope) => {
          await scope.all(query("INSERT INTO items VALUES (2)"));
          throw new Error("abort callback");
        }),
        /abort callback/u,
      );
      strict.equal((await database.one(count)).n, 1n);
      let escaped: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
      await database.transaction(async (scope) => {
        escaped = scope;
      });
      await strict.rejects(escaped!.all(count), /no longer active/u);
      await strict.rejects(
        database.transaction(async (scope) => {
          await scope.all(query("INSERT INTO items VALUES (2)"));
          void scope.all(query("SELECT missing FROM missing_table"));
        }),
        /missing_table/u,
      );
      strict.equal((await database.one(count)).n, 1n);
      strict.equal(connection.openStatementCount(), 0);
      strict.deepEqual(await database.batch([]), []);
    } finally {
      await second.close();
      await database.close();
      connection.close();
    }
  });

  await it("feeds actual PRAGMA/version evidence into the existing SQLite schema provider", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const database = createSqliteWasmDatabase(module, connection, options);
    try {
      await database.queryable.all("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, doc BLOB) STRICT");
      const snapshot = await new SqliteSchemaProvider({ client: database.queryable }).introspect();
      strict.equal(snapshot.server?.versionKey, "3.54.1");
      strict.ok(snapshot.server?.features.length);
      strict.equal(snapshot.tables.items?.columns.id?.tsType, "bigint");
      strict.equal(snapshot.tables.items?.columns.name?.tsType, "string");
      strict.equal(snapshot.tables.items?.columns.doc?.tsType, "Uint8Array");
    } finally {
      await database.close();
      connection.close();
    }
  });

  await it("quarantines a connection after rollback failure and can still close its owned resource", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const faulty: SqliteWasmConnection = {
      get pointer() {
        return connection.pointer;
      },
      prepare(text) {
        if (text === "ROLLBACK") throw new Error("rollback unavailable");
        return connection.prepare(text);
      },
      isOpen: () => connection.isOpen(),
      close: () => connection.close(),
      dbVfsName: () => connection.dbVfsName(),
    };
    const database = createSqliteWasmDatabase(module, faulty, { ...options, ownsConnection: true });
    try {
      await strict.rejects(
        database.transaction(async () => {
          throw new Error("original callback error");
        }),
        /original callback error/u,
      );
      await strict.rejects(database.queryable.all("SELECT 1"), /unusable/u);
    } finally {
      await database.close();
    }
    strict.equal(connection.isOpen(), false);
  });

  await it("leaves an application's pre-existing transaction untouched", () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    try {
      connection.exec("BEGIN");
      strict.throws(() => createSqliteWasmDatabase(module, connection, options), /idle connection/u);
      strict.equal(module.capi.sqlite3_get_autocommit(connection.pointer!), 0);
      connection.exec("ROLLBACK");
    } finally {
      connection.close();
    }
  });

  await it("keeps injected resources application-owned and closes explicitly owned resources idempotently", async () => {
    const connection = new sqlite3.oo1.DB(":memory:");
    const database = createSqliteWasmDatabase(module, connection, options);
    await database.close();
    await database.close();
    strict.equal(connection.isOpen(), true);
    await strict.rejects(database.queryable.all("SELECT 1"), /closed/u);
    const owned = createSqliteWasmDatabase(module, connection, { ...options, ownsConnection: true });
    await owned.close();
    await owned.close();
    strict.equal(connection.isOpen(), false);
    strict.throws(() => createSqliteWasmDatabase(module, connection, options), /closed/u);
  });
});
