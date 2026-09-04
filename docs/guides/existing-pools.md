---
title: Adopt an existing pool or connection
description: Add typed-sql execution to application-owned pg, mysql2, or SQLite resources without transferring lifecycle ownership.
pageType: how-to
---

# Adopt an existing pool or connection

Wrap a resource that the application already creates when you want typed-sql execution APIs without
moving connection configuration or shutdown responsibility.

## PostgreSQL `pg` pool

```ts
import { Pool } from "pg";
import { typePolicy } from "@typed-sql/postgres";
import { adaptPgPool } from "@typed-sql/postgres/pg";
import { createPostgresDatabase } from "@typed-sql/postgres/runtime";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const database = createPostgresDatabase({
  pool: adaptPgPool(pool),
  ownsPool: false,
  typePolicy,
});

try {
  const rows = await database.all(accountById(42n));
} finally {
  await database.close();
  await pool.end();
}
```

`adaptPgPool` lazily loads cursor and COPY support when those capabilities are used. It also applies
the adapter's prepared-statement and connection-safety rules. Do not configure pg's client-side
`query_timeout`; use PostgreSQL `statement_timeout` for a server-enforced pool-wide limit and use
typed-sql execution deadlines for individual supported operations.

## MySQL `mysql2` pool

```ts
import { createPool } from "mysql2/promise";
import { typePolicy } from "@typed-sql/mysql";
import { adaptMySql2Pool } from "@typed-sql/mysql/mysql2";
import { createMySqlDatabase } from "@typed-sql/mysql/runtime";

const pool = createPool(process.env.DATABASE_URL!);
const database = createMySqlDatabase({
  pool: adaptMySql2Pool(pool),
  ownsPool: false,
  typePolicy,
});

try {
  const rows = await database.all(accountById(42n));
} finally {
  await database.close();
  await pool.end();
}
```

The adapter uses mysql2's execute protocol, keeps multi-statement execution outside typed-sql's
managed constructor, and preserves the application pool's ownership. If the existing pool uses custom
decoding, configure the matching typed-sql type policy and codecs before relying on inferred runtime
values.

## Existing `node:sqlite` connection

```ts
import { DatabaseSync } from "node:sqlite";
import { typePolicy } from "@typed-sql/sqlite";
import { adaptNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { createSqliteDatabase } from "@typed-sql/sqlite/runtime";

const connection = new DatabaseSync("app.db");
const database = createSqliteDatabase({
  connection: adaptNodeSqliteDatabase(connection, { typePolicy }),
  ownsConnection: false,
});

try {
  const rows = await database.all(accountById(42n));
} finally {
  await database.close();
  connection.close();
}
```

The built-in adapter is synchronous beneath its promise-shaped API and does not advertise
cancellation or deadlines. `ownsConnection: false` prevents `database.close()` from closing the
underlying connection.

## Ownership rules

- Keep exactly one shutdown owner for every pool or connection.
- Use `ownsPool: false` and `ownsConnection: false` for application-owned resources; these are also the
  runtime constructors' defaults.
- Finish typed-sql streams and transaction scopes before ending the underlying resource.
- A transaction-scoped database never owns pool or connection lifecycle.
- Do not keep using a transaction after a driver operation or cancellation has invalidated it.
- Match compile-time and runtime type policies, including bigint, decimal, date, JSON, binary, and
  SQLite storage-class behavior.

For constructors that create and own their resources, use [Execute queries](./execution.md#connect-an-adapter).
