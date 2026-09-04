---
title: Get started
description: Choose a database and follow the shortest path from schema evidence to a checked, executable query.
pageType: landing
---

# Get started

typed-sql adds a schema-aware compiler to SQL templates while leaving database connections and query
execution under application control.

```text
database schema -> generated snapshot -> sql template -> compiler check -> driver execution
```

The snapshot is compiler input. Application code imports `sql` from its grammar package and continues
to use an explicitly installed driver or typed-sql runtime adapter.

## Choose a database

| Database | Grammar import | Runtime choice | Support details |
| --- | --- | --- | --- |
| PostgreSQL | `@typed-sql/postgres` | Application-owned `pg` directly or `@typed-sql/postgres/pg` | [PostgreSQL](../dialects/postgresql.md) |
| MySQL | `@typed-sql/mysql` | Application-owned `mysql2` directly or `@typed-sql/mysql/mysql2` | [MySQL](../dialects/mysql.md) |
| SQLite | `@typed-sql/sqlite` | Injected connection or the optional `@typed-sql/sqlite/node-sqlite` adapter | [SQLite](../dialects/sqlite.md) |

All three grammars are stable. Their supported database ranges and exact verification targets are
different, so check the linked dialect page before choosing a production version.

## The shortest path

1. [Install the grammar and your driver](./installation.md).
2. [Configure introspection](./configuration.md) and generate a snapshot.
3. [Write and check a query](./first-query.md).
4. [Choose direct driver use or a runtime adapter](../guides/adapters.md).

The maintained [complete applications](../examples/index.md) are useful when you prefer to begin from
runnable source instead of assembling the steps in an existing project.

## Understand the checking workflow

`typed-sql check` is the stable, authoritative compiler path. Published declarations remain
conservative, so an ordinary TypeScript server can display `Query<unknown>` even when the compiler
proves an exact result. The optional language server supplies exact editor hovers through an isolated
preview TypeScript process and is experimental.

Read [Compiler and editor workflow](./compiler-and-editor.md) before configuring editor integration.

## Add production controls when needed

A first query does not require manifests, live verification, query-plan capture, or migration
compatibility analysis. These are independent operational layers. Start with the
[operations overview](../operations/index.md) when the basic compiler and execution loop is working.
