---
title: typed-sql documentation
description: Write ordinary SQL and receive exact TypeScript row and parameter types from your database schema.
---

# typed-sql documentation

typed-sql is a TypeScript SQL compiler. It analyzes static SQL templates against a generated snapshot of your database and carries the inferred row and parameter types through application code.

It is not an ORM or a query builder. SQL remains visible, database drivers remain application-owned, and generated files contain schema metadata rather than an application API.

## Start here

1. [Install typed-sql](./getting-started/installation.md) for PostgreSQL or MySQL.
2. [Configure schema introspection](./getting-started/configuration.md).
3. [Write and check your first query](./getting-started/first-query.md).
4. [Execute queries](./guides/execution.md) with your selected driver.

## Guides

- [Compose conditional SQL](./guides/composition.md) without creating a parallel query-builder API.
- [Generate snapshots and detect drift](./guides/schema-snapshots.md).
- [Trace database work safely](./guides/observability.md) through the neutral observer contract.
- [Configure Zed, VS Code, or another LSP client](./guides/editors.md).
- Review the [PostgreSQL](./dialects/postgresql.md) and [MySQL](./dialects/mysql.md) grammar boundaries.

## Concepts and reference

- [Architecture](./concepts/architecture.md)
- [Inference and safety](./concepts/type-safety.md)
- [Performance](./concepts/performance.md)
- [Query API](./reference/api.md)
- [Compatibility](./reference/compatibility.md)
- [Database type mappings](./reference/type-mappings.md)
- [Diagnostics](./reference/diagnostics.md)
- [Authoring a custom grammar](./extending/custom-grammars.md)

## Core guarantees

- Static, supported SQL receives an exact row type and ordered parameter tuple.
- Unsupported or ambiguous SQL produces a diagnostic or a conservative `unknown`, never `any` or a guessed type.
- Query values remain driver parameters unless you explicitly opt into structural SQL.
- Installing a grammar does not install a database driver.
- Application code imports `sql` from its dialect package, never from generated output.
