---
title: typed-sql documentation
description: Write ordinary SQL and receive exact TypeScript row and parameter types from your database schema.
---

# typed-sql documentation

typed-sql is a TypeScript SQL compiler. It analyzes static SQL templates against a generated snapshot of your database and carries the inferred row and parameter types through application code.

It is not an ORM or a query builder. SQL remains visible, database drivers remain application-owned, and generated files contain schema metadata rather than an application API.

## Start here

1. [Install typed-sql](./getting-started/installation.md) for PostgreSQL, MySQL, or the SQLite preview.
2. [Configure schema introspection](./getting-started/configuration.md).
3. [Write and check your first query](./getting-started/first-query.md).
4. [Execute queries](./guides/execution.md) with your selected driver.

## Guides

- [Compose conditional SQL](./guides/composition.md) without creating a parallel query-builder API.
- [Validate decoded query results](./guides/result-validation.md) with any Standard Schema implementation.
- [Generate snapshots and detect drift](./guides/schema-snapshots.md).
- [Trace database work safely](./guides/observability.md) through the neutral observer contract.
- [Route safe reads and retry explicit transactions](./guides/routing-and-retries.md) with application-owned topology.
- [Emit deterministic query manifests](./guides/query-manifests.md) for CI and production correlation.
- [Govern query plans](./guides/query-plan-governance.md) with redacted optimizer evidence and explicit budgets.
- [Verify compiler evidence against a live database](./guides/live-verification.md) and cache the proof.
- [Check migrations against compiled queries](./guides/migration-compatibility.md) in both rolling-deployment directions.
- [Configure Zed, VS Code, or another LSP client](./guides/editors.md).
- Review the [PostgreSQL](./dialects/postgresql.md), [MySQL](./dialects/mysql.md), and [SQLite](./dialects/sqlite.md) grammar boundaries.

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
