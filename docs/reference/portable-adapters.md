---
title: Portable buffered adapters
pageType: reference
description: Use explicit D1, libSQL, Neon, Postgres.js, and SQLite Wasm adapters with compiled value plans and honest transport capabilities.
---

# Portable buffered adapters

`@typed-sql/adapters` provides explicit buffered adapters for application-owned database clients.
Its runtime depends only on `@typed-sql/core`. Install your chosen driver separately. Grammar
`/query` entrypoints export `sql`, a renderer, and portable value conversion without importing
the grammar parser or a Node database adapter.

These adapters require a compiled query value plan, or an explicit `decodeRows` function supplied
by the application. A type-only editor overlay does not create runtime metadata. Use the build
frontend or SQL-file factory when you want the compiler's type policy enforced at runtime.

| Factory / subpath | Native atomic batch | Callback transaction | Other capability |
| --- | --- | --- | --- |
| `createD1Database` / `d1` | Yes | No | D1 sessions and bookmarks |
| `createLibsqlDatabase` / `libsql` | Yes | Yes | Application owns client lifetime |
| `createNeonHttpDatabase` / `neon-http` | Yes, one HTTP request | No | Noninteractive transactions |
| `createNeonWebSocketDatabase` / `neon-ws` | Yes, reserved connection | Yes | Application owns the pool |
| `createPostgresJsDatabase` / `postgres-js` | Yes, native transaction | Yes | Uses raw result cells |
| `createSqliteWasmDatabase` / `sqlite-wasm` | Yes, explicit SQLite transaction | Yes | Injected official OO1 connection; application owns its VFS |

All expose `execute`, `all`, `one`, and `maybeOne`. Streaming, cancellation, and deadlines are not
provided by these wrappers. Unsupported controls fail before query dispatch. Callback scopes
cannot be used after their callback completes. Already-dispatched work is drained before commit
or rollback, and a failed scoped operation prevents committing the transaction.

## D1

Configure the SQLite grammar with `integer: "number"` and use STRICT tables. D1's JavaScript API
does not support bigint values. The adapter rejects bigint plans, bigint inputs, unsafe integer
numbers, and incompatible type-policy hashes rather than attempting to recover rounded values.

```ts
import { createD1Database, d1Sessions } from "@typed-sql/adapters/d1";
import { requireAdapterCapability } from "@typed-sql/core";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import findUser, { valuePlan } from "./find-user.sql";

const database = createD1Database(env.DB, {
  renderer: sqliteRenderer,
  profile: {
    id: "d1",
    dialect: "sqlite",
    integer: "safe-number",
    jsonWire: "text",
    typePolicyHash: valuePlan.typePolicyHash,
  },
});

const user = await database.maybeOne(findUser(1));
const session = requireAdapterCapability(database, d1Sessions).withSession("first-primary");
const rows = await session.all(findUser(1));
const bookmark = session.getBookmark();
```

Use `database.batch([...])` for D1's native atomic batch. Sending `BEGIN` through a callback wrapper
is not a substitute for D1 transactions. See the official [binding API](https://developers.cloudflare.com/d1/worker-api/)
and [sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## libSQL / Turso

```ts
import { createClient } from "@libsql/client";
import { createLibsqlDatabase } from "@typed-sql/adapters/libsql";
import { sqliteRenderer } from "@typed-sql/sqlite/query";

const client = createClient({ url: "file:local.db", intMode: "bigint" });
const database = createLibsqlDatabase(client, {
  renderer: sqliteRenderer,
  profile: { id: "libsql", dialect: "sqlite", integer: "lossless", jsonWire: "text" },
});
```

The driver must retain integer precision. `intMode: "bigint"` preserves SQLite's full integer
range. The adapter requires bigint wire values for bigint logical plans; it does not coerce REAL
numbers or text into integers. Converting an already-rounded number to bigint cannot recover
precision and is rejected. Native transactions
are opened in write mode and explicitly committed or rolled back. Close the application-owned
client when its lifetime ends. See [libSQL client configuration](https://tursodatabase.github.io/libsql-client-ts/interfaces/Config.html).

## PostgreSQL clients

Use `postgresRenderer` and `normalizePostgresValue` from `@typed-sql/postgres/query` with a
`{ dialect: "postgres", integer: "lossless", jsonWire: "text" }` transport profile. Put the
normalizer in `profile.normalizeValue`. It handles PostgreSQL text scalars, arrays, booleans,
dates, and bytea before neutral value-plan validation.

`createNeonHttpDatabase` accepts `neon(url, { fullResults: true })` from
`@neondatabase/serverless`. The wrapper supplies raw type parsers for individual queries and batch
queries so driver JSON parsing cannot discard numeric text. HTTP batches are noninteractive;
there is no callback transaction method.

`createNeonWebSocketDatabase` accepts an application-owned Neon `Pool`. It reserves a connection
for each callback transaction and supplies raw per-query parsers. Configure the driver's WebSocket
implementation for your runtime. `createPostgresJsDatabase` accepts a `postgres` client and uses
its native `begin` API and raw byte results. Neither wrapper closes an injected client or pool.

See the official [Neon driver configuration](https://github.com/neondatabase/serverless/blob/main/CONFIG.md)
and [Postgres.js documentation](https://github.com/porsager/postgres).

## Official SQLite Wasm

Initialize `@sqlite.org/sqlite-wasm` in the application and wrap an OO1 connection. The same adapter
works with an in-memory database or an application-configured persistent VFS in a worker. The driver
and its Wasm assets are explicit application dependencies; the adapter does not load them.

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createSqliteWasmDatabase } from "@typed-sql/adapters/sqlite-wasm";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import findUser, { valuePlan } from "./find-user.sql";

const sqlite3 = await sqlite3InitModule();
const connection = new sqlite3.oo1.DB(":memory:");
const database = createSqliteWasmDatabase(sqlite3, connection, {
  renderer: sqliteRenderer,
  profile: {
    id: "sqlite-wasm",
    dialect: "sqlite",
    integer: "lossless",
    jsonWire: "text",
    typePolicyHash: valuePlan.typePolicyHash,
  },
  ownsConnection: true,
});

// After the application creates its schema and data:
const user = await database.maybeOne(findUser(1n));
await database.close();
```

INTEGER storage is read as `bigint`, including small integers. A number policy converts it only after
checking that it is safe. REAL values remain numbers; a REAL value cannot satisfy a bigint plan.
Bindings reject out-of-range 64-bit bigints, non-finite numbers, unsafe integer numbers and
unserialized objects before the statement executes. Blob results are copied before finalization.
SQLite JSON text and JSONB retain the compiled policy's text/blob representation.

Each query contains exactly one SQL statement. Callback transactions hold an exclusive connection
lease; use the provided scope for every operation until it completes. Root operations and other
wrappers of that connection are rejected during the callback. Pending scoped failures prevent commit,
escaped scopes are retired, and a failed rollback makes the connection unusable until it is closed.
`batch()` is atomic. Statements are finalized on success and failure.

`ownsConnection` defaults to `false`. Closing an injected wrapper leaves its connection open; closing
an explicitly owned connection does not delete its database or release application-owned VFS pools.
`database.evidence` records the actual library version, compile options and VFS. Pass
`database.queryable` to `new SqliteSchemaProvider({ client: database.queryable })` from
`@typed-sql/sqlite` to reuse its catalog and snapshot logic. The queryable shares the connection lease;
its raw results are schema inputs, while application queries use compiled value plans.

For persistent browser databases, see [SQLite Wasm persistence](../guides/sqlite-wasm.md)
for OPFS headers, SAH-pool ownership, asset delivery and recovery.

## Verification boundaries

Local tests exercise actual workerd D1 bindings, the libSQL file client, Postgres.js against local
PostgreSQL, and the actual Neon WebSocket driver through a local WebSocket-to-PostgreSQL bridge.
The Neon HTTP test exercises its real driver against a controlled fetch response, including exact
JSON text and single-request batching. These tests do not establish remote provider availability,
replica consistency, or production network behavior.

```sh
pnpm --filter @typed-sql/adapters test
TYPED_SQL_ADAPTER_POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm --filter @typed-sql/adapters test:postgres
```

The PostgreSQL command requires a disposable local database and uses temporary tables. Cloud
credentials and deployments are not required for these local checks.

## Optional remote smoke

The repository's `smoke:remote` command is opt-in. It runs a bound `SELECT 7` through exactly one
selected adapter, does not create tables or resources, and closes its own driver client. Configure
only endpoints you control and credentials suitable for read-only queries. Remote provider behavior
is unverified until this command succeeds against that provider.

```sh
TYPED_SQL_REMOTE_ADAPTER=libsql TYPED_SQL_LIBSQL_URL=libsql://your-database.turso.io TYPED_SQL_LIBSQL_AUTH_TOKEN=... pnpm --filter @typed-sql/adapters smoke:remote
TYPED_SQL_REMOTE_ADAPTER=neon-http TYPED_SQL_NEON_URL=... pnpm --filter @typed-sql/adapters smoke:remote
TYPED_SQL_REMOTE_ADAPTER=neon-ws TYPED_SQL_NEON_URL=... pnpm --filter @typed-sql/adapters smoke:remote
TYPED_SQL_REMOTE_ADAPTER=postgres-js TYPED_SQL_POSTGRES_URL=... pnpm --filter @typed-sql/adapters smoke:remote
```

For D1, the binding exists inside your Worker. The repository includes the read-only
`packages/adapters/test/helpers/d1-smoke-worker.ts` entrypoint: bundle it with your normal Worker toolchain,
configure a `DB` binding and a `SMOKE_TOKEN` secret, and deploy it yourself. The command never deploys
or changes Worker configuration. Then set `TYPED_SQL_REMOTE_ADAPTER=d1`, `TYPED_SQL_D1_SMOKE_URL`
and `TYPED_SQL_D1_SMOKE_TOKEN` before running `smoke:remote`. It checks the authenticated Worker's
response; it does not replace the D1 binding with Cloudflare's separate REST query API.
