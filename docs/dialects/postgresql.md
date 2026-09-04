---
title: PostgreSQL
pageType: reference
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
their major. The exact release-matrix targets are 14.24, 15.19, 16.15, 17.11, and 18.6. PostgreSQL
19beta3 is a non-blocking canary and requires `postgres({ versionPolicy: "canary" })`; prerelease
evidence does not enter the stable range or its pass score. Unlisted older or newer majors remain
conservative.

`POSTGRES_SUPPORT_POLICY` exposes the selected major lines, matrix minors, canary identity, and
deprecation rule. typed-sql announces an upstream end-of-life removal at least 90 days ahead, keeps
the major through its upstream final release, and removes it no earlier than the first typed-sql
minor released afterward.

Every query is resolved against normalized server evidence. A generated snapshot records the full
server version, normalized major, `standard_conforming_strings`, effective search path, installed
extension identities, catalog revision, visibility scope, schema identity, and type-policy identity.
Missing or malformed evidence, an unsupported major, an unavailable versioned feature, or an
incompatible lexical setting produces `TSQ402`–`TSQ407` or conservative `unknown`; it never inherits
the newest grammar behavior. Unqualified names follow the captured search path and current-role
visibility. Prefer schema-qualified names when compilation and execution can use different roles or
search paths.

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
| Expressions, `CASE`, casts, and parameters | Infers parameters from columns, casts, DML targets, ranges, limits, and catalog functions. Generated catalogs record canonical identities, preferred categories, every direct cast among shipped core types for PostgreSQL 14–18, versioned additions and removals, and PostgreSQL's automatic string I/O conversion rules. PostgreSQL interval literals preserve optional precision and the valid single-field or field-range qualifiers while resolving to the canonical `interval` type. Scalar and row-valued `IN` lists and subqueries validate equality operators, row arity, and per-position parameter types. Quantified array/subquery and row comparisons use element-wise operator selection. `COLLATE` preserves collatable string types, while `AT TIME ZONE` selects the exact timestamp, timestamp-with-time-zone, or time-with-time-zone conversion signature and validates text or interval zones. PostgreSQL 17+ `AT LOCAL` applies the corresponding session-zone conversion. Exact numeric promotion, mathematical prefix, bit shift, concatenation, money, `pg_lsn`, unary numeric, bitwise, geometric, and asymmetric temporal arithmetic operators use fail-closed candidate selection. |
| Arrays, enums, domains, composites, JSON, and catalog functions | Selects typed operator and snapshot-routine candidates using exact and implicit-cast matches. Resolves array subscripts and slices, snapshot-backed parenthesized composite field selection and field-wise composite comparisons, named, defaulted, and variadic calls, array/range/enum relationships, range and multirange operators, network address operators, geometric transformation, position, intersection, distance, containment, and relationship operators, full-text composition and matching, JSON/JSONB/JSONPATH typed literals, JSON-path predicates and deletion, and all `jsonb_path_*` scalar and set-returning signatures. The `anyelement` and `anycompatible` polymorphic families resolve from grammar-owned evidence; unresolved or ambiguous candidates fail closed. |
| SQL/JSON expressions and row sources | PostgreSQL 16+ `JSON_OBJECT` and `JSON_ARRAY` own standard key/value, query, null-handling, uniqueness, input-format, and `RETURNING` clauses while preserving legacy `json_object(...)` function calls. Constructor keys must be non-null scalar values; formatted inputs and outputs validate JSON-compatible types and UTF-8 encoding. PostgreSQL 16+ `JSON_OBJECTAGG` and `JSON_ARRAYAGG` additionally own aggregate null handling, uniqueness, input ordering, `FILTER`, `OVER`, output formats, grouping checks, parameter inference, and nullable empty-input results. PostgreSQL 16+ `IS JSON` validates value, scalar, array, object, and unique-key constraints for JSON-compatible string, binary, `json`, and `jsonb` inputs while preserving SQL-null propagation. PostgreSQL 17+ `JSON`, `JSON_SCALAR`, and `JSON_SERIALIZE` resolve JSON parsing, scalar conversion, string or binary serialization, null propagation, uniqueness, formats, encodings, and return types; the overlapping pre-17 functional `json(...)` cast remains version-aware. PostgreSQL 17+ `JSON_EXISTS`, `JSON_QUERY`, and `JSON_VALUE` own their context, path, `PASSING`, `FORMAT JSON`, encoding, and error-behavior syntax. `JSON_QUERY` additionally resolves JSON wrappers and quote behavior; `JSON_QUERY` and `JSON_VALUE` resolve `RETURNING`, constant `ON EMPTY` and `ON ERROR` defaults, and output nullability. `JSON_VALUE` maps JSON null to nullable SQL output and rejects collection fallbacks or formatted returns. `JSON_TABLE` owns its row-source grammar, constant root and column paths, path names, passing variables, ordinality, scalar, formatted, `EXISTS`, and recursively nested columns, output alias lists, and top-level error behavior. It flattens nested output columns, applies nested null-padding, resolves declared types and boolean coercions, and participates in implicit lateral scope. These forms infer parameters where PostgreSQL provides type context and fail closed on invalid behavior or type combinations. Older servers and missing server-version evidence produce version diagnostics. |
| `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `RETURNING` | Covers identity overriding, snapshot-backed expression and partial-index conflict targets, action-scoped `excluded`, row/subquery assignments, comma and joined update/delete sources, positioned `WHERE CURRENT OF` writes, source-type validation, PostgreSQL 15+ `MERGE`, PostgreSQL 17+ merge returning and explicit by-target/by-source actions, and PostgreSQL 18 old/new rows and aliases. Commands without `RETURNING` infer `Query<never, Parameters>`. |

Dynamic identifiers receive no static inference; use `sql.ident()` explicitly.

Expression collation preserves exact built-in string types. Catalog-wide validation of collation
names remains conservative when the schema snapshot does not carry collation inventory evidence.

Unsupported, ambiguous, or version-gated SQL produces a diagnostic or conservative `unknown`. It does not receive an optimistic row type.

## Introspection

The provider records tables, views, materialized views, foreign tables, partition parents and
strategies, columns, defaults, constraints, indexes, arrays, enums, domains, composites, ranges,
multiranges, and user routines for the configured schemas. Routine evidence includes argument
names, modes, defaults, polymorphic family, volatility, strictness, parallel safety, and scalar,
set, record, table, or command results. Server evidence records the exact server version, installed
extension identities, `standard_conforming_strings`, search path, and the fact that catalog
visibility is scoped to the current database role without storing the role name. Generated
snapshots include grammar, catalog, type-policy, normalized capability, and explicit introspection
scope evidence.

Stable resolution covers the documented PostgreSQL major range. Canary testing is explicit:
`postgres({ versionPolicy: "canary" })` selects the grammar-owned canary major; prerelease text never
satisfies the stable range accidentally.

### Extension manifests

`definePostgresExtensionManifest()` declares an extension name, an exact installed-version list,
and a reviewable manifest revision. Active manifests may contribute snapshot-v2 types and routines,
unary or binary operator signatures, cast contexts, runtime codecs, and an optional driver-neutral
introspection callback. Pass manifests to `postgres({ extensions })` for analysis and to
`PostgresSchemaProvider({ extensionManifests })` when their introspection callbacks should augment a
generated snapshot.

Manifests activate only when the snapshot records a matching installed extension version. Unknown
extensions remain conservative. Unsupported versions produce `TSQ403`; conflicting type, routine,
operator, cast, or codec declarations produce `TSQ407` and make query semantics unknown. Codec and
introspection callbacks receive typed-sql's driver-neutral contracts, so importing the default
PostgreSQL entrypoint does not load `pg` or another database driver.

For execution, pass the generated snapshot path as `compatibilitySnapshot` and the same manifests as
`extensionManifests` to `createPgDatabase()`. The adapter resolves each active codec's database type
to connection-local scalar and array OIDs, then installs those decoders per query. The generated file
remains a compiler artifact referenced by path; application modules do not import APIs from it.

`createPgLiveVerifier()` sends PostgreSQL Parse and Describe protocol messages without Bind or
Execute, so every supported major supplies parameter OIDs and result-column OIDs without receiving
application values. The verifier resolves those OIDs through `pg_type`, then deallocates the named
statement. See [Live verification](../guides/live-verification.md).

`createPgPlanInspector()` uses JSON `EXPLAIN` without `ANALYZE`. PostgreSQL 16 and newer use
`GENERIC_PLAN`; PostgreSQL 14 and 15 force a generic prepared plan in a rolled-back transaction.
Neither path needs parameter values. Optional transient samples request a custom plan. Normalized
evidence excludes expressions and literals. See [Query plan governance](../guides/query-plan-governance.md).

`createPostgresRoutedDatabase()` composes application-owned databases and parses runtime query shapes with the PostgreSQL grammar. Stable, non-locking reads may use a supplied replica. `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`, writes, volatile functions, session state, and unknown statements use primary. `isPostgresRetryableTransactionError()` recognizes only transaction rollback SQLSTATE `40001` and deadlock SQLSTATE `40P01`. See [Route reads and retry transactions](../guides/routing-and-retries.md).

## Runtime behavior

The adapter installs parsers per query and does not mutate `pg.types`. Boolean, integer, floating,
`bigint`, `numeric`, temporal, JSON, `bytea`, and their supported arrays use typed-sql's codec policy;
enums remain strings, domains retain their base representation, and types without a typed-sql or
manifest codec delegate to the installed driver's parser table. `bytea` is normalized to
`Uint8Array`. Driver settings that would contradict the selected type policy are rejected.

When `compatibilitySnapshot` is present, `createPgDatabase()` reads that generated artifact and
negotiates the target before returning. It rejects mismatched grammar versions, server majors,
extension versions, lexical settings, search paths, built-in catalog revisions, schema identities,
or type-policy identities with `PostgresRuntimeCompatibilityError`. Without that option, database
creation retains the lazy connection behavior and makes no artifact-compatibility claim.

Use PostgreSQL's server-enforced `statement_timeout` when a pool-wide statement deadline is required. `createPgDatabase` rejects pg's client-side `query_timeout` in both `poolConfig` and the resolved connection URI, including URIs returned by an asynchronous provider. `adaptPgPool` applies the same check to an application-created pool's exposed options and raw connection URI. pg can report this client timeout before the server reaches `ReadyForQuery`, so returning the connection to the pool would be unsafe. As a conservative fallback for opaque pool implementations, root batches and streams discard their checked-out client after a query or cursor rejection. A transaction scope cannot continue after a driver operation rejects: a root scope rolls back, while a successfully rolled-back nested savepoint lets its parent continue. The checked-out client is still discarded when the outer transaction finishes. Callback-only failures that roll back successfully do not discard an otherwise healthy client.

`all`, `one`, and `maybeOne` accept an `AbortSignal` and absolute deadline. Because node-postgres does not expose a safe signal contract for an individual pool query, typed-sql leases a client and destroys that lease when a control fires. The cancelled transaction cannot continue. This is client-side interruption by conservative connection discard, not a PostgreSQL cancel request; use server-side statement timeouts when the database itself must enforce a limit.

The runtime constructors and `pg` adapter accept a grammar-neutral `observer`. Query, prepared-query, batch, pipeline, stream, cancellation, and nested-transaction lifecycles carry PostgreSQL compiler-compatible fingerprints without exposing SQL or values. See [Observe database work](../guides/observability.md).

`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. Buffered execution passes the stable name to `pg`. Each connection retains at most
`statementCacheSize` named statements (256 by default) using LRU eviction. Successful schema DDL or
`search_path` changes advance a pool-wide generation; every connection issues `DEALLOCATE ALL`
before its next query. The factory caches its first structural SQL skeleton and rejects duplicate
names or structural drift between calls.
Homogeneous fragment lists may vary only in cardinality; `preparedCardinalityVariantLimit` bounds
their rendered per-factory LRU at 32 variants by default.

Driver failures are exposed as `PostgresAdapterError` with a stable `kind` of `timeout`,
`transaction-abort`, `connection-loss`, `server`, or `driver`, the SQLSTATE when one exists, and the
original failure as `cause`. These outcomes contain neither SQL text nor bound values. Explicit
typed-sql cancellation remains `QueryCancelledError` with code `TSQL_CANCELLED`.

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
