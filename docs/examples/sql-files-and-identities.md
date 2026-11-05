---
title: SQL files and application identities
description: Import named SQL queries, distinguish user and order IDs, and include SQL assets in deployment checks.
pageType: tutorial
---

# SQL files and application identities

This example uses the [commerce schema](./commerce-schema.md). A user ID and an order ID are both
SQL bigints, but they represent different application identities. Brand those columns once in the
schema provider, then let imported SQL and tagged templates carry the same contract.

Open the [playground](../playground.md) and select **Branded application IDs** to try the example in
PostgreSQL, MySQL, or SQLite. **SQL parameter bindings** demonstrates named objects and positional
binding without brands. Both examples use the actual SQL-file binding analyzer.

## Declare identities in the provider

For PostgreSQL, wrap the application-owned introspection provider:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";
import { withSchemaBrands } from "@typed-sql/schema";

const provider = pg({
  connectionString: () => process.env.DATABASE_URL!,
  typePolicy,
});

export default defineConfig({
  dialect: postgres({ typePolicy }),
  typePolicy,
  schema: {
    file: "generated/db/schema.json",
    provider: {
      async introspect() {
        return withSchemaBrands(await provider.introspect(), {
          columns: {
            users: { id: "UserId" },
            orders: { id: "OrderId", user_id: "UserId" },
          },
        });
      },
    },
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  manifest: { outFile: ".typed-sql/queries.json" },
});
```

Use exact snapshot keys. Explicitly give a foreign-key column the same brand as the identity it
references. The same `withSchemaBrands` wrapper works with MySQL and SQLite providers.
[Schema snapshots](../guides/schema-snapshots.md#brand-application-identities) also covers domain
identities, supported scalar types, and trust boundaries.

Generate the snapshot with `typed-sql generate`, and configure one of the
[SQL-file build integrations](../integrations/index.md). Brands are snapshot metadata; application
queries continue importing from the selected grammar or their `.sql` file.

## Import a named query

Write `src/queries/order.sql`:

```sql
SELECT id, user_id, status
FROM orders
WHERE user_id = :userId AND id = :orderId
```

The SQL file takes one object. Validate external values at your application boundary before
establishing their identities:

```ts
import { brandValue } from "@typed-sql/core";
import order from "./queries/order.sql";

const userId = brandValue(42n, "UserId");
const orderId = brandValue(9001n, "OrderId");
const query = order({ userId, orderId });
const row = await database.maybeOne(query);
```

The factory requires `UserId` for `userId` and `OrderId` for `orderId`. Passing `orderId` into
`userId`, or passing a plain bigint, is a TypeScript error. Rows retain the brands on `id` and
`user_id`, including through direct projections, aliases, and CTEs. `brandValue` leaves the bigint
unchanged; it does not validate business rules or encode a new database type.

## Repeat and reorder bindings

A named parameter can occur more than once while remaining one object property. Each occurrence
becomes a bound value. Named and positional styles cannot be mixed, and inconsistent type contexts
produce a diagnostic. See [SQL file parameters](../guides/sql-files.md#bind-named-parameters).

PostgreSQL numbered bindings can repeat and appear in a different order:

```sql
SELECT id, email FROM users
WHERE email <> $2 AND (id = $1 OR id = $1)
```

With the branded schema, call the factory with `(userId, "excluded@example.com")`.
Its argument order is numeric: ID first, email second. The resulting query's bound parameter tuple
is `readonly [string, UserId, UserId]`, matching SQL occurrence order. MySQL and SQLite `?`
arguments follow occurrence order. Numeric gaps remain errors.

## Include SQL assets in deployment checks

The import in the configured TypeScript project makes `order.sql` part of the query inventory:

```sh
pnpm exec typed-sql manifest
```

Its entry records the original `.sql` location, source hash, inferred types and dependencies.
It does not persist SQL text or argument values. Editing or removing the imported file invalidates
the corresponding evidence; regenerate the manifest before using downstream artifacts.

| Workflow | SQL-file evidence |
| --- | --- |
| [Live verification](../guides/live-verification.md) | Prepare/describe metadata is compared with the compiled query contract. Brands are compared by their underlying wire scalar. |
| [Plan capture](../guides/query-plan-governance.md) | The inspector receives the same expanded SQL and occurrence-ordered parameters used by the factory. |
| [Migration compatibility](../guides/migration-compatibility.md) | Before/after manifests identify affected `.sql` queries and their dependencies. |

Configure the documented PostgreSQL/MySQL verifier or inspector before running `typed-sql verify
--live` or `typed-sql explain`. SQLite can contribute manifests and offline compatibility evidence;
it does not ship a live-verification or plan-inspection adapter. The browser playground checks
inference and diagnostics only; it does not connect to a database or run these artifact commands.
