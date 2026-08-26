---
title: PostgreSQL
description: PostgreSQL grammar coverage, catalog introspection, application-owned pg integration, and deliberate limitations.
---

# PostgreSQL

`@typed-sql/postgres` contains the PostgreSQL grammar, catalog model, resolver, type policy, and runtime codecs. The optional `@typed-sql/postgres/pg` entrypoint loads the `pg` driver installed by your application. Streaming additionally uses the application-owned `pg-cursor` package.

## Public entrypoints

- `@typed-sql/postgres` — `sql`, dialect factory, default type policy, analysis, and type mapping.
- `@typed-sql/postgres/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/postgres/pg` — schema provider and executable database adapter for application-owned `pg`.

## Supported SQL

| Surface | Behavior |
| --- | --- |
| Static tagged templates | Recognizes imports and aliases from `@typed-sql/postgres`. |
| `SELECT`, `DISTINCT`, `DISTINCT ON` | Infers static row shapes. |
| Tables, schemas, aliases, and stars | Resolves catalog names, ambiguity, and `USING` column merging. |
| Inner and outer joins | Propagates outer-join nullability. |
| CTEs and derived, correlated, or scalar subqueries | Validates unsafe scalar and `IN` arity. |
| Grouping, aggregates, and windows | Covers common aggregates, `FILTER`, and named or inline windows. |
| Expressions, `CASE`, casts, and parameters | Infers parameters from columns, casts, DML targets, ranges, limits, and catalog functions. |
| Arrays, enums, domains, JSON, and catalog functions | Resolves known types and function name or arity. |
| `INSERT`, `UPDATE`, `DELETE`, `RETURNING` | Commands without `RETURNING` infer `Query<never, Parameters>`. |

Set operations and `WITHIN GROUP` are not supported. Dynamic identifiers receive no static inference; use `sql.ident()` explicitly.

Unsupported, ambiguous, or version-gated SQL produces a diagnostic or conservative `unknown`. It does not receive an optimistic row type.

## Introspection

The provider records tables, views, columns, defaults, server version, arrays, enums, domains, and user functions for the configured schemas. Generated snapshots include grammar, catalog, and type-policy hashes.

## Runtime behavior

The adapter installs parsers per query and does not mutate `pg.types`. Policy-controlled OIDs are decoded by typed-sql; other OIDs delegate to the installed driver's parser table. Driver settings that would contradict the selected type policy are rejected.

Use PostgreSQL's server-enforced `statement_timeout` when a pool-wide statement deadline is required. `createPgDatabase` rejects pg's client-side `query_timeout` in both `poolConfig` and the resolved connection URI, including URIs returned by an asynchronous provider. `adaptPgPool` applies the same check to an application-created pool's exposed options and raw connection URI. pg can report this client timeout before the server reaches `ReadyForQuery`, so returning the connection to the pool would be unsafe. As a conservative fallback for opaque pool implementations, root batches and streams discard their checked-out client after a query or cursor rejection. A transaction scope cannot continue after a driver operation rejects: a root scope rolls back, while a successfully rolled-back nested savepoint lets its parent continue. The checked-out client is still discarded when the outer transaction finishes. Callback-only failures that roll back successfully do not discard an otherwise healthy client. A timeout does not imply support for `AbortSignal` or a PostgreSQL cancel request.

`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. Buffered execution passes the stable name to `pg`, whose prepared statements are cached per PostgreSQL connection. The factory caches its first structural SQL skeleton and rejects duplicate names or structural drift between calls.

`database.batch(queries)` checks out one `pg` client and dispatches the queries sequentially. It is not a pipeline and does not combine statements into one SQL string or network round trip. Root batches use PostgreSQL's ordinary autocommit behavior; transactional statements can use an explicit typed-sql transaction when atomicity is required.

`database.pipeline(queries)` is the explicit lower-latency alternative for independent PostgreSQL statements. It requires `pg` 8.23.0 or newer. Enable node-postgres's public pipeline mode through `poolConfig: { pipeline: true }` or an application-created `Pool({ pipeline: true })`. The adapter checks the leased client's public `pipeline` flag, dispatches every typed query before awaiting results, and preserves exact tuple order and prepared names. It waits for all responses before releasing the client. Because later statements are already in flight, pipeline failure semantics are intentionally different from `batch()`: dispatch does not stop at the first server error. Root pipelines are non-atomic; transaction pipelines are atomic only through the surrounding PostgreSQL transaction.

## Streaming

Install `pg-cursor` only in applications that call `stream()`:

```sh
pnpm add pg-cursor
```

The adapter imports it when iteration starts, leases one `pg` pool client, and reads cursor pages according to `batchSize`. Completing or closing the stream closes the portal before the client is returned to the pool. Missing `pg-cursor` produces an actionable error at first iteration; ordinary execution and prepared factories never load it.

`pg-cursor` always parses its cursor statement unnamed. A query produced by `database.prepare()` remains valid for streaming and retains its inferred row and parameter types, but the cursor path cannot reuse the prepared statement name used by buffered `pg` execution.

Inside a transaction, the stream reuses the transaction client and never releases it directly. The stream must complete or close before the transaction callback returns. Transaction `execute()`, `batch()`, and `pipeline()` calls must likewise be awaited before return; the adapter settles outstanding work before rollback and never selects commit first.

See [Execute queries](../guides/execution.md), [Database type mappings](../reference/type-mappings.md#postgresql), and [Compatibility](../reference/compatibility.md).
