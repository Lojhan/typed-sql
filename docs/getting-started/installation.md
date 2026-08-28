---
title: Installation
description: Install typed-sql with a PostgreSQL, MySQL, or SQLite grammar and an application-owned database driver.
---

# Installation

typed-sql requires Node.js 22.11 or newer and TypeScript 7.0.2. Choose one dialect and install its driver explicitly.

## PostgreSQL

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript@7.0.2
```

Applications that call `database.stream()` also install the application-owned PostgreSQL cursor package:

```sh
pnpm add pg-cursor
```

Buffered execution, transactions, and prepared factories do not load `pg-cursor`.

## MySQL

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

The grammar package owns SQL parsing, catalog introspection, type resolution, and runtime codecs. Your application owns the driver version, connection configuration, pool, and lifecycle.

## SQLite preview

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript@7.0.2
```

The optional Node adapter uses the built-in `node:sqlite` module, so it installs no npm driver. Use
Node 22.13 or newer for `StatementSync.iterate()` support. Other SQLite adapters can implement the
driver-neutral runtime contract without changing the grammar.

## OpenTelemetry

Database tracing is optional and independent of the selected dialect:

```sh
pnpm add @typed-sql/opentelemetry @opentelemetry/api
```

The integration does not install an SDK, exporter, or database driver. See [Observe database work](../guides/observability.md).

## Editor tooling

The language server is optional and experimental:

```sh
pnpm add -D @typed-sql/language-server
```

It contains its own isolated TypeScript preview process. You do not need a workspace `tsserver.js` or a separate preview installation. See [Editor setup](../guides/editors.md).

## Package boundary

Installing a dialect never installs a database driver. PostgreSQL and MySQL applications install
`pg` or `mysql2` themselves; SQLite's Node adapter loads the built-in module only when selected.

Driver-specific behavior is available only from explicit adapter entrypoints:

- `@typed-sql/postgres/pg`
- `@typed-sql/mysql/mysql2`
- `@typed-sql/sqlite/node-sqlite`

Continue with [Configuration](./configuration.md).
