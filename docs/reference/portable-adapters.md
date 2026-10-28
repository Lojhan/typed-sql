---
title: Portable buffered adapters
pageType: reference
description: Use explicit D1, libSQL, Neon, and Postgres.js adapters with compiled value plans and honest transport capabilities.
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
