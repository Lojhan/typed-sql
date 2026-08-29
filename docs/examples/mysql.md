---
title: MySQL example
description: Run a complete typed-sql MySQL application with conditional SQL and the application-owned mysql2 driver.
---

# MySQL example

This example deliberately has the same application shape as the PostgreSQL version. The selected grammar owns
MySQL syntax, placeholders, semantics, and decoding while the application continues to write ordinary SQL.

## Define the database

The pinned container initializes this schema:

<<< ../../examples/mysql/schema/001-schema.sql

The config selects MySQL, `mysql2` introspection, generated output, and a shared type policy:

<<< ../../examples/mysql/typed-sql.config.ts

`mysql2` belongs to the example application and is not installed by the grammar package.

## Compose native SQL

Conditional fragments control selection, the dependent join, and nullable filters. Ordinary interpolations stay
ordered driver values.

<<< ../../examples/mysql/src/queries.ts

The MySQL renderer uses `?` placeholders while preserving the same parameter tuple represented by the query.

## Execute through mysql2

The official adapter executes the query through the application-owned pool:

<<< ../../examples/mysql/src/run.ts

## Run it

From the repository root:

```sh
pnpm --filter @typed-sql/example-mysql db:up
pnpm --filter @typed-sql/example-mysql generate
pnpm --filter @typed-sql/example-mysql check
pnpm --filter @typed-sql/example-mysql start
pnpm --filter @typed-sql/example-mysql db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` before the container commands to use Podman. Set `DATABASE_URL` to
target another MySQL database. The [MySQL dialect guide](../dialects/mysql.md) documents its grammar and adapter
boundaries.
