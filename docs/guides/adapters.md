---
title: Choose a driver or runtime adapter
description: Decide between rendering typed queries for a driver directly and using typed-sql execution adapters.
pageType: explanation
---

# Choose a driver or runtime adapter

typed-sql does not require an execution adapter. The compiler produces a typed query contract; the
application decides how that contract reaches its database driver.

## Choose an integration level

| Approach | Keep | Add | Best fit |
| --- | --- | --- | --- |
| Render and call the driver | Existing driver calls and lifecycle | Grammar renderer and inferred query contract | Incremental adoption or unsupported driver features |
| Adapt an existing pool | Existing pool configuration and ownership | typed-sql cardinality, transaction, batch, prepare, stream, and observation APIs | Established `pg` or `mysql2` applications |
| Let the adapter create a pool/connection | Grammar, type policy, and connection settings | Managed typed-sql runtime surface | New integration with one clear owner |
| Implement a neutral connection contract | Application-specific driver | Driver-neutral PostgreSQL, MySQL, or SQLite runtime | Another driver or platform adapter |

All approaches keep the database driver as an explicit application dependency.

## Render for direct driver execution

Use the dialect renderer with `renderQuery` when existing data-access infrastructure should continue
to own dispatch:

```ts
import { renderQuery } from "@typed-sql/core";
import { sql } from "@typed-sql/postgres";
import { postgresRenderer } from "@typed-sql/postgres/runtime";

const query = sql`SELECT id, email FROM users WHERE id = ${42n}`;
const rendered = renderQuery(query, postgresRenderer);

const result = await pool.query(rendered.text, [...rendered.values]);
```

The query retains its compile-time contract, but the raw driver call determines the runtime result
surface. Driver parsing must still agree with the configured typed-sql type policy.

## Use a typed-sql adapter

The driver-specific constructors create their underlying resource and close it when the database is
closed:

- `createPgDatabase` from `@typed-sql/postgres/pg`;
- `createMySql2Database` from `@typed-sql/mysql/mysql2`;
- `createNodeSqliteDatabase` from `@typed-sql/sqlite/node-sqlite`.

They expose common cardinality and transaction contracts plus dialect capabilities such as PostgreSQL
pipelines/COPY, MySQL LOAD DATA, and driver-specific streaming. See [Execute queries](./execution.md).

## Preserve an existing resource

When the application already owns a pool or SQLite connection, wrap that resource and pass
`ownsPool: false` or `ownsConnection: false`. Closing the typed-sql database does not close the
application resource.

Follow [Adopt an existing pool or connection](./existing-pools.md) for concrete examples and lifecycle
rules.

## Keep dialect behavior in the dialect

The neutral database API does not make all protocols equivalent. Cancellation, deadlines, pipelines,
bulk transfer, warnings, prepared statements, streaming, and connection failure cleanup remain
dialect/adapter capabilities. Inspect `database.executionCapabilities` and the selected
[dialect contract](../dialects/index.md) instead of assuming feature parity.
