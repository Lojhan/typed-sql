---
title: Query and check loop
description: Understand how a dialect SQL template becomes an exact row type, ordered parameter tuple, rendered statement, or conservative failure.
pageType: tutorial
---

# Query and check loop

Every dialect follows the same development loop: import its `sql` tag, write a static template, run
the stable compiler check, then execute the unchanged query object through an application-owned
driver or adapter.

## Import from the selected grammar

| Database | Application import | Placeholder form |
| --- | --- | --- |
| PostgreSQL | `@typed-sql/postgres` | `$1`, `$2`, … |
| MySQL | `@typed-sql/mysql` | `?` |
| SQLite | `@typed-sql/sqlite` | `?` |

Do not import `sql` from generated output. The configured grammar owns syntax, name resolution,
built-ins, coercions, nullability, and diagnostics.

## Write static SQL with parameter values

This checked PostgreSQL fixture selects a database enum and one `bigint` parameter:

<!-- docs:start homepage-postgres-query -->
```ts
import { sql } from "@typed-sql/postgres";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
```
<!-- docs:end homepage-postgres-query -->

The interpolation is always a value. It renders as `$1` for PostgreSQL or `?` for MySQL and SQLite;
typed-sql never concatenates it into the SQL text.

## Run the authoritative check

```sh
pnpm exec typed-sql check --project tsconfig.json
```

The compiler extracts the complete template, renders placeholders for the selected grammar, resolves
it against the configured snapshot, and asks TypeScript to check the inferred overlay without
rewriting source.

For the maintained PostgreSQL schema, the exact contract is:

<!-- docs:start homepage-postgres-contract -->
```ts
type AccountByIdQuery = Query<
  { "id": bigint; "email": string; "status": "active" | "suspended"; },
  readonly [bigint]
>;
```
<!-- docs:end homepage-postgres-contract -->

`Query` carries one row shape and an ordered tuple of all interpolated values. Adapter methods decide
whether execution returns many rows, one row, or an optional row.

## Reuse the contract

```ts
import type { QueryParameters, QueryRow } from "@typed-sql/core";

type Account = QueryRow<ReturnType<typeof accountById>>;
type AccountParameters = QueryParameters<ReturnType<typeof accountById>>;
```

These utilities follow the compiler-proven query instead of duplicating a hand-written interface.

## Observe the failure boundary

If the schema says `id` is `bigint`, this value fails the transformed TypeScript check:

```ts
const wrongId = "42";

sql`SELECT id FROM users WHERE id = ${wrongId}`;
```

Unsupported, ambiguous, invalid, stale, or dynamic SQL resolves to a diagnostic or conservative
`unknown`, never `any` or an optimistic guess. This is compile-time evidence; runtime result
validation is separate and opt-in.

## Continue with a complete path

Follow the [PostgreSQL](./postgresql.md), [MySQL](./mysql.md), or [SQLite](./sqlite.md) quickstart to
create schema evidence and execute the query. Then choose [direct driver use or an adapter](../guides/adapters.md).
