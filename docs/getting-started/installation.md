---
title: Installation
description: Install typed-sql with the PostgreSQL or MySQL grammar and an application-owned database driver.
---

# Installation

typed-sql requires Node.js 22.11 or newer and TypeScript 7.0.2. Choose one dialect and install its driver explicitly.

## PostgreSQL

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript@7.0.2
```

## MySQL

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

The grammar package owns SQL parsing, catalog introspection, type resolution, and runtime codecs. Your application owns the driver version, connection configuration, pool, and lifecycle.

## Editor tooling

The language server is optional and experimental:

```sh
pnpm add -D @typed-sql/language-server
```

It contains its own isolated TypeScript preview process. You do not need a workspace `tsserver.js` or a separate preview installation. See [Editor setup](../guides/editors.md).

## Package boundary

Installing `@typed-sql/postgres` does not install `pg`, MySQL packages, or another database client. Installing `@typed-sql/mysql` follows the same rule for `mysql2`.

Driver-specific behavior is available only from explicit adapter entrypoints:

- `@typed-sql/postgres/pg`
- `@typed-sql/mysql/mysql2`

Continue with [Configuration](./configuration.md).
