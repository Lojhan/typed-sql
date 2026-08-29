---
title: PostgreSQL example
description: Run a complete typed-sql PostgreSQL application with conditional SQL and the application-owned pg driver.
---

# PostgreSQL example

This application keeps ordinary PostgreSQL at the center of the API while exercising the complete `pg` adapter
surface. Boolean selection changes the projected row shape, nullable filters add ordered parameters, and the
join only exists when its projected column is requested.

| Area | Demonstrated behavior |
| --- | --- |
| Read and write | Dynamic queries, CTEs, cardinality helpers, inserts, updates, deletes, transactions |
| Reuse and concurrency | Prepared queries, transactional batches, PostgreSQL pipeline mode |
| Large results and data transfer | Cursor-backed async iteration, COPY import and export |
| Production controls | Standard Schema validation, cancellation, deadlines, read routing, redacted observation |

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

## Mutations and cardinality

Mutations are ordinary tagged SQL and use PostgreSQL `RETURNING` when the caller needs a typed row:

<<< ../../examples/postgres/src/mutations.ts

The database contract makes expected cardinality explicit instead of returning the same array shape for every
operation:

<<< ../../examples/postgres/src/cardinality.ts

Transactions keep the same inferred query rows across the callback boundary:

<<< ../../examples/postgres/src/transactions.ts

## Prepared, batched, and pipelined work

Prepared query factories keep parameter inference at the call site:

<<< ../../examples/postgres/src/prepared.ts

Independent or transactional work uses adapter capabilities rather than a second query language:

<<< ../../examples/postgres/src/batches.ts

<<< ../../examples/postgres/src/pipelines.ts

## Streaming and COPY

The async iterable is cursor-backed, and collected rows retain `QueryRow<typeof activeAccounts>`:

<<< ../../examples/postgres/src/streams.ts

COPY is exposed by the PostgreSQL adapter as an explicit capability:

<<< ../../examples/postgres/src/bulk.ts

## Validation and production controls

Any Standard Schema-compatible validator can decode the inferred result before it reaches the caller:

<<< ../../examples/postgres/src/validation.ts

Cancellation and deadlines operate on driver work, routing uses a validated grammar snapshot, and observation
never exposes query text or parameter values:

<<< ../../examples/postgres/src/cancellation.ts

<<< ../../examples/postgres/src/routing.ts

<<< ../../examples/postgres/src/observation.ts

## Execute through pg

The adapter consumes the same query object and closes its application-owned pool:

<<< ../../examples/postgres/src/run.ts

The real Poku suite creates actual rows and verifies queries, CTEs, prepared statements, transactions, pipeline
mode, cursor streaming, COPY, cancellation, routing, observation, and cleanup against the pinned server:

<<< ../../examples/postgres/database-test/capabilities.test.ts

## Run it

From the repository root:

```sh
pnpm --filter @typed-sql/example-postgres db:up
pnpm --filter @typed-sql/example-postgres generate
pnpm --filter @typed-sql/example-postgres check
pnpm --filter @typed-sql/example-postgres test
pnpm --filter @typed-sql/example-postgres start
pnpm --filter @typed-sql/example-postgres test:database
pnpm --filter @typed-sql/example-postgres db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` before the container commands to use Podman. Set `DATABASE_URL` to
target another PostgreSQL database. The [PostgreSQL dialect guide](../dialects/postgresql.md) covers the full
grammar and adapter surface.
