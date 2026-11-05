import sqlite3InitModule, { type Database, type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmDatabase, type SqliteWasmDatabase } from "@typed-sql/adapters/sqlite-wasm";
import { getQueryValuePlan } from "@typed-sql/core";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import document from "./document.sql";
import find from "./find.sql";
import insert from "./insert.sql";
import positional from "./positional.sql";

let sqlite3: Sqlite3Static | undefined;
let connection: Database;
let database: SqliteWasmDatabase;
let pool: SAHPoolUtil | undefined;
let held: Promise<void>;
let releaseHeld: () => void;
const schema =
  "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, bytes BLOB NOT NULL, maybe TEXT) STRICT";
const plan = getQueryValuePlan(find({ id: 1n }));
if (!plan) throw new Error("Build integration did not compile SQL-file value plans");
const options = {
  renderer: sqliteRenderer,
  ownsConnection: true,
  profile: {
    id: "sqlite-wasm-browser",
    dialect: "sqlite",
    integer: "lossless",
    jsonWire: "text",
    typePolicyHash: plan.typePolicyHash,
  },
};
function wrap() {
  database = createSqliteWasmDatabase(sqlite3, connection, options);
}
function input(id, name = "Ada") {
  return insert({ id, name, payload: JSON.stringify({ name }), bytes: Uint8Array.of(0, 255), maybe: null });
}
function check(value, message) {
  if (!value) throw new Error(message);
}
async function rejects(operation, pattern) {
  try {
    await operation();
  } catch (error) {
    check(pattern.test(String(error)), `Unexpected error: ${error}`);
    return String(error);
  }
  throw new Error("Expected operation to reject");
}
const methods = {
  async open({ backend, directory }) {
    if (backend === "opfs" && !globalThis.crossOriginIsolated)
      throw new Error("OPFS requires cross-origin isolation (COOP/COEP) and SharedArrayBuffer");
    sqlite3 ??= await sqlite3InitModule({ print: () => {}, printErr: () => {} });
    if (backend === "opfs") {
      if (!sqlite3.oo1.OpfsDb) throw new Error("OPFS VFS is unavailable; no memory fallback");
      connection = new sqlite3.oo1.OpfsDb(`/${directory}.sqlite3`, "c");
    } else if (backend === "opfs-sahpool") {
      pool ??= await sqlite3.installOpfsSAHPoolVfs({
        directory: `.${directory}`,
        initialCapacity: 6,
        preserveOnInitFailure: true,
      });
      if (pool.isPaused()) await pool.unpauseVfs();
      connection = new pool.OpfsSAHPoolDb("/items.sqlite3");
    } else throw new Error("Unsupported persistence backend");
    connection.exec("PRAGMA busy_timeout=0");
    connection.exec(schema);
    wrap();
    return {
      ...database.evidence,
      isolated: globalThis.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    };
  },
  async write({ id, name }) {
    return database.one(input(id, name));
  },
  async read({ id }) {
    return database.maybeOne(find({ id }));
  },
  async exercise() {
    const max = 9223372036854775807n,
      min = -9223372036854775808n;
    const name = "Ada'; DROP TABLE items; --";
    await database.one(input(max, name));
    await database.one(input(min, "Min"));
    const row = await database.one(find({ id: max }));
    check(
      row.id === max && row.name === name && row.real === 1 && row.maybe === null,
      "Lossless named/repeated parameters or row decoding failed",
    );
    check(row.bytes instanceof Uint8Array && row.bytes[0] === 0 && row.bytes[1] === 255, "BLOB decoding failed");
    check((await database.one(find({ id: min }))).id === min, "Minimum signed int64 changed");
    check(JSON.parse(row.payload).name === name, "JSON text changed");
    check(row.bytes[1] === 255, "BLOB was not copied");
    const ordered = await database.one(positional(name, max));
    check(ordered.id === max && ordered.name === name, "Positional order failed");
    const doc = await database.one(document({ id: max }));
    check(doc.binary instanceof Uint8Array && doc.name === name, "JSONB storage or JSON extraction failed");
    await rejects(() => database.one(find({ id: "invalid" })), /bigint/);
    await rejects(() => database.batch([input(10n), input(10n)]), /constraint|UNIQUE/i);
    check((await database.maybeOne(find({ id: 10n }))) === undefined, "Batch did not roll back");
    await rejects(
      () =>
        database.transaction(async (tx) => {
          await tx.one(input(11n));
          throw new Error("rollback marker");
        }),
      /rollback marker/,
    );
    check((await database.maybeOne(find({ id: 11n }))) === undefined, "Transaction did not roll back");
    await database.transaction(async (tx) => {
      await tx.one(input(12n));
    });
    check((await database.one(find({ id: 12n }))).id === 12n, "Transaction did not commit");
    check(connection.openStatementCount() === 0, "Statements leaked");
    return {
      named: true,
      repeated: true,
      positional: true,
      int64: true,
      real: true,
      blobs: true,
      jsonb: true,
      nulls: true,
      batchRollback: true,
      transactionRollback: true,
      statements: 0,
    };
  },
  async hold() {
    let ready: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    held = database.transaction(async (tx) => {
      await tx.one(input(90n, "uncommitted"));
      ready();
      await wait;
      throw new Error("held rollback");
    });
    held.catch(() => {});
    await Promise.race([started, held]);
    return true;
  },
  async finish() {
    releaseHeld();
    await rejects(() => held, /held rollback/);
    return connection.openStatementCount();
  },
  async close() {
    await database.close();
    if (pool) pool.pauseVfs();
    return true;
  },
};
self.onmessage = async ({ data }) => {
  try {
    const value = await methods[data.method](data.args);
    self.postMessage({ id: data.id, value });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
