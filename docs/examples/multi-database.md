---
title: PostgreSQL and SQLite example
pageType: tutorial
description: Use two typed-sql grammars, configs, generated schemas, and drivers in one TypeScript application.
---

# PostgreSQL and SQLite example

A project can use more than one database without merging their grammars or generated schemas. This example keeps
customer records in PostgreSQL and customer preferences in a local SQLite database, then combines both typed
results in one application service.

| Boundary | PostgreSQL | SQLite |
| --- | --- | --- |
| Grammar | `@typed-sql/postgres` | `@typed-sql/sqlite` |
| Driver | Application-owned `pg` | Node's built-in `node:sqlite` |
| Config | `postgres/typed-sql.config.ts` | `sqlite/typed-sql.config.ts` |
| Generated contract | `postgres/generated/db` | `sqlite/generated/db` |
| Source ownership | Customer records | Customer preferences |

## Configure each database independently

The PostgreSQL directory owns its connection, grammar, introspection provider, schema snapshot, and queries:

<<< ../../examples/multi-database/postgres/typed-sql.config.ts

<<< ../../examples/multi-database/postgres/src/queries.ts

The SQLite directory has a separate type policy input, generated snapshot, and query module:

<<< ../../examples/multi-database/sqlite/typed-sql.config.ts

<<< ../../examples/multi-database/sqlite/src/queries.ts

Running `generate` refreshes both contracts. Running `check` analyzes each source directory against its matching
grammar and schema instead of applying one dialect to the entire TypeScript project.

## Combine typed results in application code

The service accepts both explicit database contracts. Each query remains owned and inferred by its grammar; the
application can execute them concurrently and return one combined profile:

<<< ../../examples/multi-database/src/service.ts

The write is deliberately a SQLite transaction only. Two unrelated drivers do not become an atomic distributed
transaction merely because one function uses both. Applications that require cross-database atomicity need an
explicit coordination pattern such as an outbox or saga.

## Execute and prove both drivers

The entrypoint creates and closes both adapters:

<<< ../../examples/multi-database/src/run.ts

The real Poku suite starts from reproducible PostgreSQL and SQLite schemas, reads both sources, updates SQLite,
reads the combined profile again, and closes both drivers:

<<< ../../examples/multi-database/database-test/multi-database.test.ts

From the repository root:

```sh
pnpm --filter @typed-sql/example-multi-database db:up
pnpm --filter @typed-sql/example-multi-database generate
pnpm --filter @typed-sql/example-multi-database check
pnpm --filter @typed-sql/example-multi-database test
pnpm --filter @typed-sql/example-multi-database start
pnpm --filter @typed-sql/example-multi-database test:database
pnpm --filter @typed-sql/example-multi-database db:down
```

Use `node examples/e2e.mjs multi-database` to run that complete lifecycle with guaranteed container teardown.
For dialect-specific hovers in Zed, open either database subdirectory as a workspace; each contains settings that
select its own config while sharing the parent TypeScript project.
