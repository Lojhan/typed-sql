---
title: SQLite example
description: Run a complete typed-sql SQLite application with conditional SQL and Node's built-in SQLite driver.
---

# SQLite example

The SQLite example uses the same structural query primitives as PostgreSQL and MySQL. It needs no container or
third-party driver because the explicit adapter targets Node's built-in `node:sqlite` module.

## Define the database

The setup script recreates a local database from this strict SQLite schema:

<<< ../../examples/sqlite/schema/001-schema.sql

The config selects the SQLite grammar, local schema provider, generated output, and matching runtime type policy:

<<< ../../examples/sqlite/typed-sql.config.ts

## Compose native SQL

SQLite's grammar analyzes the complete query after all conditional fragments are composed:

<<< ../../examples/sqlite/src/queries.ts

SQLite cannot derive an enum from a `CHECK` constraint, so `status` remains `string`. The selected `budget`
column is `number | null` under this type policy.

## Execute through node:sqlite

The adapter presents the same promise-shaped database contract even though the underlying built-in driver is
synchronous:

<<< ../../examples/sqlite/src/run.ts

## Run it

From the repository root:

```sh
pnpm --filter @typed-sql/example-sqlite generate
pnpm --filter @typed-sql/example-sqlite check
pnpm --filter @typed-sql/example-sqlite start
```

Both `generate` and `start` recreate the scoped `examples/sqlite/example.sqlite` file before use. The
[SQLite dialect guide](../dialects/sqlite.md) describes its dynamic-typing, threading, and execution constraints.
