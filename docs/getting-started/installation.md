---
title: Choose packages
description: Install one typed-sql grammar, the stable compiler CLI, and an explicit application-owned database driver.
pageType: how-to
---

# Choose packages

Install one grammar for the database used by the application. Add the stable CLI as a development
dependency, then select a database driver explicitly—grammar packages never install or own one.

## Prerequisites

typed-sql requires Node.js 22.11 or newer. The compiler uses an exact supported TypeScript version;
check the current [compatibility matrix](../reference/compatibility.md#runtime-and-compiler) before
installing into an existing project.

## PostgreSQL

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/postgres`. The optional runtime and introspection
adapter is an explicit subpath at `@typed-sql/postgres/pg` and loads the application's `pg` package.

[Continue with the PostgreSQL quickstart](./postgresql.md).

## MySQL

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/mysql`. The adapter at
`@typed-sql/mysql/mysql2` loads the application's `mysql2` package.

[Continue with the MySQL quickstart](./mysql.md).

## SQLite

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript
```

Application code imports `sql` from `@typed-sql/sqlite`. The optional
`@typed-sql/sqlite/node-sqlite` adapter uses the built-in `node:sqlite` module on supported Node
versions, so there is no npm driver dependency.

[Continue with the SQLite quickstart](./sqlite.md).

## Optional packages

Add these only when their capability is used:

| Package | Use it for | Stability |
| --- | --- | --- |
| `@typed-sql/opentelemetry` and `@opentelemetry/api` | Translate neutral database observations into application-owned spans | Stable |
| `pg-cursor` | Cursor-backed PostgreSQL streams | Application dependency |
| `@typed-sql/language-server` | Exact hovers and SQL editor features | Experimental |

The language server owns its isolated TypeScript preview internally. It is not required for
generation, checking, or execution. See [Compiler and editor workflow](./compiler-and-editor.md).

## Dependency boundary

Keep driver packages in application dependencies even when a dialect happens to use their types.
This makes the selected protocol, connection configuration, pool, codecs, and lifecycle visible to
the application. [Compare direct driver use and adapters](../guides/adapters.md).
