---
title: PostgreSQL example
description: Run a complete typed-sql PostgreSQL application with conditional SQL and the application-owned pg driver.
---

# PostgreSQL example

This example keeps ordinary SQL at the center of the API. Boolean selection changes the projected row shape,
nullable filters add ordered driver parameters, and the join only exists when its projected column is requested.

## Define the database

The pinned container initializes this small schema:

<<< ../../examples/postgres/schema/001-schema.sql

The application selects the PostgreSQL grammar, live schema provider, generated output, project, and one shared
type policy:

<<< ../../examples/postgres/typed-sql.config.ts

`pg` is installed by the example application. It is not a dependency of the grammar package.

## Compose native SQL

The function composes only typed-sql primitives. Values remain parameters; selected columns, joins, and
predicates remain explicit structural fragments.

<<< ../../examples/postgres/src/queries.ts

Hover `activeAccounts` in a configured editor to see its selected row and ordered parameter tuple. Changing
`projectBudget` or `status` changes the complete query type instead of widening it to a hand-written interface.

## Execute through pg

The adapter consumes the same query object and closes its application-owned pool:

<<< ../../examples/postgres/src/run.ts

## Run it

From the repository root:

```sh
pnpm --filter @typed-sql/example-postgres db:up
pnpm --filter @typed-sql/example-postgres generate
pnpm --filter @typed-sql/example-postgres check
pnpm --filter @typed-sql/example-postgres start
pnpm --filter @typed-sql/example-postgres db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` before the container commands to use Podman. Set `DATABASE_URL` to
target another PostgreSQL database. The [PostgreSQL dialect guide](../dialects/postgresql.md) covers the full
grammar and adapter surface.
