---
title: MySQL example
description: Run a complete typed-sql MySQL application with conditional SQL and the application-owned mysql2 driver.
---

# MySQL example

This example deliberately has the same application shape as the PostgreSQL version. The selected grammar owns
MySQL syntax, placeholders, semantics, and decoding while the application continues to write ordinary SQL.

| Area | Demonstrated behavior |
| --- | --- |
| Read and write | Dynamic queries, CTEs, cardinality helpers, inserts, updates, deletes, transactions |
| Reuse and batching | Prepared queries and transactional batches |
| Large results and data transfer | mysql2-backed async iteration and `LOAD DATA LOCAL INFILE` import |
| Production controls | Standard Schema validation, cancellation, deadlines, read routing, redacted observation |

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

## Mutations and cardinality

<<< ../../examples/mysql/src/mutations.ts

<<< ../../examples/mysql/src/cardinality.ts

Transactions preserve typed rows through the mysql2 connection callback:

<<< ../../examples/mysql/src/transactions.ts

## Prepared, batched, streamed, and bulk work

<<< ../../examples/mysql/src/prepared.ts

<<< ../../examples/mysql/src/batches.ts

<<< ../../examples/mysql/src/streams.ts

MySQL's native bulk example uses `LOAD DATA LOCAL INFILE`. It is intentionally an adapter capability rather
than a grammar-neutral promise that every database can implement:

<<< ../../examples/mysql/src/bulk.ts

## Validation and production controls

<<< ../../examples/mysql/src/validation.ts

<<< ../../examples/mysql/src/cancellation.ts

<<< ../../examples/mysql/src/routing.ts

<<< ../../examples/mysql/src/observation.ts

## Execute through mysql2

The official adapter executes the query through the application-owned pool:

<<< ../../examples/mysql/src/run.ts

The database Poku suite executes and cleans up every documented capability against the pinned MySQL server:

<<< ../../examples/mysql/database-test/capabilities.test.ts

## Run it

From the repository root:

```sh
pnpm --filter @typed-sql/example-mysql db:up
pnpm --filter @typed-sql/example-mysql generate
pnpm --filter @typed-sql/example-mysql check
pnpm --filter @typed-sql/example-mysql test
pnpm --filter @typed-sql/example-mysql start
pnpm --filter @typed-sql/example-mysql test:database
pnpm --filter @typed-sql/example-mysql db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` before the container commands to use Podman. Set `DATABASE_URL` to
target another MySQL database. The [MySQL dialect guide](../dialects/mysql.md) documents its grammar and adapter
boundaries.
