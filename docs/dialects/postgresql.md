---
title: PostgreSQL
description: PostgreSQL grammar coverage, catalog introspection, application-owned pg integration, and deliberate limitations.
---

# PostgreSQL

`@typed-sql/postgres` contains the PostgreSQL grammar, catalog model, resolver, type policy, and runtime codecs. The optional `@typed-sql/postgres/pg` entrypoint loads the `pg` driver installed by your application. Streaming additionally uses the application-owned `pg-cursor` package.

## Public entrypoints

- `@typed-sql/postgres` — `sql`, dialect factory, default type policy, analysis, type mapping, semantic routing, and transaction retry classification.
- `@typed-sql/postgres/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/postgres/pg` — schema provider, executable database adapter, lazy live verifier, and structured-plan inspector for application-owned `pg`.

## Supported versions

The stable grammar supports PostgreSQL majors 14 through 18. Patch releases are compatible within
their major; the release matrix selects one current upstream minor for each major. PostgreSQL 19 is
a non-blocking canary and requires `postgres({ versionPolicy: "canary" })`; prerelease evidence does
not enter the stable range implicitly. Unlisted older or newer majors remain conservative.

`POSTGRES_SUPPORT_POLICY` exposes the selected major lines, matrix minors, canary identity, and
deprecation rule. typed-sql announces an upstream end-of-life removal at least 90 days ahead, keeps
the major through its upstream final release, and removes it no earlier than the first typed-sql
minor released afterward.

## Supported SQL

| Surface | Behavior |
| --- | --- |
| Static tagged templates | Recognizes imports and aliases from `@typed-sql/postgres`. |
| `SELECT`, `DISTINCT`, `DISTINCT ON` | Infers static row shapes and validates leftmost `ORDER BY` agreement. |
| Tables, schemas, aliases, and stars | Resolves catalog names, ambiguity, and `USING` column merging. |
| Inner and outer joins | Propagates outer-join nullability. |
| Ordinary and recursive CTEs; derived, correlated, or scalar subqueries | Infers seed/member rows, validates recursive shape, models PostgreSQL 14+ `SEARCH`/`CYCLE` generated columns conservatively, and gates unaliased derived tables to PostgreSQL 16+. |
| `UNION`, `INTERSECT`, and `EXCEPT` | Preserves leftmost output names, merges row types and nullability, and diagnoses arity mismatches. |
| Grouping and aggregates | Covers grouping sets, `ROLLUP`, `CUBE`, functional dependencies, aggregate ordering, `FILTER`, and ordered/hypothetical-set aggregates. |
| Windows | Covers named inheritance, inline definitions, all frame units, bounds, exclusions, and built-in window nullability. |
| Lateral and function relations | Covers implicit/explicit lateral arguments, `ROWS FROM`, record definitions, null-padding, and `WITH ORDINALITY`. |
| Ordering, sampling, and pagination | Covers ordering operators, `TABLESAMPLE`/`REPEATABLE`, `LIMIT ALL`, offsets, and `FETCH` variants. |
| Expressions, `CASE`, casts, and parameters | Infers parameters from columns, casts, DML targets, ranges, limits, and catalog functions. Generated catalogs record canonical identities, preferred categories, and explicit/assignment/implicit cast contexts. |
| Arrays, enums, domains, JSON, and catalog functions | Selects typed operator and snapshot-routine candidates using exact and implicit-cast matches. Resolves named, defaulted, and variadic calls, array/range/enum relationships, and the `anyelement` and `anycompatible` polymorphic families; unresolved or ambiguous candidates fail closed. |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `RETURNING` | Covers identity overriding, snapshot-backed expression and partial-index conflict targets, action-scoped `excluded`, row/subquery assignments, comma and joined update/delete sources, positioned `WHERE CURRENT OF` writes, source-type validation, PostgreSQL 15+ `MERGE`, PostgreSQL 17+ merge returning and explicit by-target/by-source actions, and PostgreSQL 18 old/new rows and aliases. Commands without `RETURNING` infer `Query<never, Parameters>`. |

Dynamic identifiers receive no static inference; use `sql.ident()` explicitly.

Unsupported, ambiguous, or version-gated SQL produces a diagnostic or conservative `unknown`. It does not receive an optimistic row type.

## Introspection

The provider records tables, views, columns, defaults, server version, arrays, enums, domains, user
functions, installed extension identities, and `standard_conforming_strings` for the configured
schemas. Generated snapshots include grammar, catalog, type-policy, and normalized capability
evidence.

Stable resolution covers the documented PostgreSQL major range. Canary testing is explicit:
`postgres({ versionPolicy: "canary" })` selects the grammar-owned canary major; prerelease text never
satisfies the stable range accidentally.

`createPgLiveVerifier()` uses session-local `PREPARE` and `pg_prepared_statements` without executing the statement or sending values. PostgreSQL 18 provides parameter and result types; older versions are explicitly incomplete. See [Live verification](../guides/live-verification.md).

`createPgPlanInspector()` uses JSON `EXPLAIN` without `ANALYZE`. PostgreSQL 18 generic plans need no parameter values; optional transient samples request a custom plan. Normalized evidence excludes expressions and literals. See [Query plan governance](../guides/query-plan-governance.md).

`createPostgresRoutedDatabase()` composes application-owned databases and parses runtime query shapes with the PostgreSQL grammar. Stable, non-locking reads may use a supplied replica. `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`, writes, volatile functions, session state, and unknown statements use primary. `isPostgresRetryableTransactionError()` recognizes only transaction rollback SQLSTATE `40001` and deadlock SQLSTATE `40P01`. See [Route reads and retry transactions](../guides/routing-and-retries.md).

## Runtime behavior

The adapter installs parsers per query and does not mutate `pg.types`. Policy-controlled OIDs are decoded by typed-sql; other OIDs delegate to the installed driver's parser table. Driver settings that would contradict the selected type policy are rejected.

Use PostgreSQL's server-enforced `statement_timeout` when a pool-wide statement deadline is required. `createPgDatabase` rejects pg's client-side `query_timeout` in both `poolConfig` and the resolved connection URI, including URIs returned by an asynchronous provider. `adaptPgPool` applies the same check to an application-created pool's exposed options and raw connection URI. pg can report this client timeout before the server reaches `ReadyForQuery`, so returning the connection to the pool would be unsafe. As a conservative fallback for opaque pool implementations, root batches and streams discard their checked-out client after a query or cursor rejection. A transaction scope cannot continue after a driver operation rejects: a root scope rolls back, while a successfully rolled-back nested savepoint lets its parent continue. The checked-out client is still discarded when the outer transaction finishes. Callback-only failures that roll back successfully do not discard an otherwise healthy client.

`all`, `one`, and `maybeOne` accept an `AbortSignal` and absolute deadline. Because node-postgres does not expose a safe signal contract for an individual pool query, typed-sql leases a client and destroys that lease when a control fires. The cancelled transaction cannot continue. This is client-side interruption by conservative connection discard, not a PostgreSQL cancel request; use server-side statement timeouts when the database itself must enforce a limit.

The runtime constructors and `pg` adapter accept a grammar-neutral `observer`. Query, prepared-query, batch, pipeline, stream, cancellation, and nested-transaction lifecycles carry PostgreSQL compiler-compatible fingerprints without exposing SQL or values. See [Observe database work](../guides/observability.md).

`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. Buffered execution passes the stable name to `pg`, whose prepared statements are cached per PostgreSQL connection. The factory caches its first structural SQL skeleton and rejects duplicate names or structural drift between calls.

`database.batch(queries)` checks out one `pg` client and dispatches the queries sequentially. It is not a pipeline and does not combine statements into one SQL string or network round trip. Root batches use PostgreSQL's ordinary autocommit behavior; transactional statements can use an explicit typed-sql transaction when atomicity is required.

`database.pipeline(queries)` is the explicit lower-latency alternative for independent PostgreSQL statements. It requires `pg` 8.23.0 or newer. Enable node-postgres's public pipeline mode through `poolConfig: { pipeline: true }` or an application-created `Pool({ pipeline: true })`. The adapter checks the leased client's public `pipeline` flag, dispatches every typed query before awaiting results, and preserves exact tuple order and prepared names. It waits for all responses before releasing the client. Because later statements are already in flight, pipeline failure semantics are intentionally different from `batch()`: dispatch does not stop at the first server error. Root pipelines are non-atomic; transaction pipelines are atomic only through the surrounding PostgreSQL transaction.

## Bulk transfer

The package root exports the `postgresCopy` capability token. Applications that use it install
`pg-copy-streams` beside `pg`; ordinary execution and cursor streaming do not load that optional
package. `copyFrom()` derives PostgreSQL COPY FROM STDIN from a typed single-row `INSERT` factory,
while `copyTo()` streams raw CSV bytes from a static typed `SELECT`.

Both directions use client STDIN or STDOUT streams. The adapter never accepts a server filesystem
path or `PROGRAM`, applies native backpressure, and owns connection cleanup for completion,
cancellation, early export return, producer failure, and server rejection. See
[Transfer bulk data](../guides/bulk-data.md).

## Streaming

Install `pg-cursor` only in applications that call `stream()`:

```sh
pnpm add pg-cursor
```

The adapter imports it when iteration starts, leases one `pg` pool client, and reads cursor pages according to `batchSize`. Completing or closing the stream closes the portal before the client is returned to the pool. Missing `pg-cursor` produces an actionable error at first iteration; ordinary execution and prepared factories never load it.

`pg-cursor` always parses its cursor statement unnamed. A query produced by `database.prepare()` remains valid for streaming and retains its inferred row and parameter types, but the cursor path cannot reuse the prepared statement name used by buffered `pg` execution.

Inside a transaction, the stream reuses the transaction client and never releases it directly. The stream must complete or close before the transaction callback returns. Transaction `execute()`, `batch()`, and `pipeline()` calls must likewise be awaited before return; the adapter settles outstanding work before rollback and never selects commit first.

See [Execute queries](../guides/execution.md), [Route reads and retry transactions](../guides/routing-and-retries.md), [Database type mappings](../reference/type-mappings.md#postgresql), and [Compatibility](../reference/compatibility.md).
