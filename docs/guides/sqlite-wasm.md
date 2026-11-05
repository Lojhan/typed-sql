---
title: SQLite Wasm persistence
description: Run compiled SQLite queries in browser workers with explicit OPFS or SAH-pool storage and connection ownership.
pageType: how-to
---

# SQLite Wasm persistence

Use the official SQLite Wasm driver to open a persistent OO1 connection in a dedicated
worker, then pass that connection to `createSqliteWasmDatabase`. Your application owns
initialization, storage selection, worker messages and VFS lifetime.

```sh
pnpm add @typed-sql/core @typed-sql/sqlite @typed-sql/adapters @sqlite.org/sqlite-wasm
pnpm add -D @typed-sql/build
```

Compile queries with the [build integration](../integrations/bundlers.md). Keep the
SQLite grammar, snapshot and compiler in the build process; the browser imports the
lightweight query renderer and execution adapter. Run schema introspection through
`SqliteSchemaProvider` in your development setup and save its snapshot for builds.
The provider accepts the adapter's `database.queryable`.

## Build the worker and deliver assets

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { typedSql } from "@typed-sql/build/vite";

export default defineConfig({
  plugins: [typedSql()],
  worker: { format: "es", plugins: () => [typedSql()] },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

```ts
// main.ts
const worker = new Worker(new URL("./database.worker.ts", import.meta.url), {
  type: "module",
});
```

The `opfs` backend needs those headers on the production document too, plus compatible
cross-origin resource policies for loaded assets. Verify `crossOriginIsolated` inside
the worker. Serve the emitted `.wasm` file as `application/wasm` and keep the SDK's
OPFS proxy worker asset reachable. Production bundling must preserve these assets;
test the built site instead of relying only on the development server.

SAH-pool does not require cross-origin isolation. Both persistent backends require
browser OPFS support and storage access on a secure origin (localhost works for development).
Initialization can fail because of browser restrictions, unavailable APIs or locks.
Surface that failure; choosing memory would change persistence semantics.

## Open OPFS explicitly

```ts
// database.worker.ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmDatabase } from "@typed-sql/adapters/sqlite-wasm";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import findItem, { valuePlan } from "./find-item.sql";

if (!globalThis.crossOriginIsolated) {
  throw new Error("OPFS requires cross-origin isolation (COOP/COEP)");
}
const sqlite3 = await sqlite3InitModule();
if (!sqlite3.oo1.OpfsDb) throw new Error("OPFS VFS is unavailable");
const connection = new sqlite3.oo1.OpfsDb("/application.sqlite3", "c");
const database = createSqliteWasmDatabase(sqlite3, connection, {
  renderer: sqliteRenderer,
  profile: {
    id: "browser-sqlite",
    dialect: "sqlite",
    integer: "lossless",
    jsonWire: "text",
    typePolicyHash: valuePlan.typePolicyHash,
  },
  ownsConnection: true,
});

// After application migrations have created the table:
const item = await database.maybeOne(findItem({ id: 1n }));
// Send results through your application's request/response message protocol.
await database.close();
```

```sql
-- find-item.sql
SELECT id, name FROM items WHERE id = :id
```

OPFS can open the same file in multiple workers, subject to SQLite locking. Keep
transactions short. A competing write can fail with `SQLITE_BUSY` or `SQLITE_LOCKED`;
finish or roll back the owning transaction before retrying. A failed statement is
finalized by the adapter. The application decides retry timing and cancellation.

## Open SAH-pool explicitly

Replace the OPFS initialization and connection construction with:

```ts
const sqlite3 = await sqlite3InitModule();
const pool = await sqlite3.installOpfsSAHPoolVfs({
  directory: ".application-sqlite",
  initialCapacity: 6,
  preserveOnInitFailure: true,
});
const connection = new pool.OpfsSAHPoolDb("/application.sqlite3");
// Wrap connection with the same adapter options as above.
```

Use a stable directory across page loads. A pool owns synchronous access handles
exclusively, so another worker or tab opening that directory can fail. Set
`preserveOnInitFailure: true`: the SDK's default initialization-failure cleanup can
remove pool storage. Do not clear the pool to recover a lock conflict.

After closing every connection in the pool, release its handles explicitly:

```ts
await database.close();
pool.pauseVfs();
// Later, when this worker owns the pool again:
await pool.unpauseVfs();
const reopened = new pool.OpfsSAHPoolDb("/application.sqlite3");
```

Releasing handles preserves files. A worker that failed initialization should be
restarted after the owner releases its handles, avoiding the SDK's cached failed
initialization promise. `removeVfs()` and `clearOnInit` are destructive operations,
and are not part of normal close, handoff or retry.

## Query and transport policy

INTEGER storage reaches the adapter as lossless `bigint`; REAL stays `number`,
BLOBs are copied `Uint8Array`s, and NULL stays `null`. JSON text and JSONB follow
the grammar's compiled text/blob policy. Structured worker messages preserve bigint
and byte arrays; JSON serialization needs an application-defined encoding for them.

Use the callback scope inside `database.transaction()`. Other operations on that
connection are rejected until the transaction finishes. `batch()` rolls back all
statements when one fails. Closing the adapter closes its OO1 connection only with
`ownsConnection: true`; it never pauses or deletes application-owned pools.

The [compatibility matrix](../reference/compatibility.md#browser-sqlite-persistence)
records the exact tested SDK and persistence scenarios. The repository's packed
browser consumer exercises compiled named, repeated and positional parameters,
64-bit values, JSONB, rollback, reload persistence and competing-worker recovery.
