---
title: MySQL
description: MySQL grammar coverage, catalog introspection, application-owned mysql2 integration, and deliberate limitations.
---

# MySQL

`@typed-sql/mysql` contains the MySQL grammar, catalog model, resolver, type policy, and runtime codecs. The optional `@typed-sql/mysql/mysql2` entrypoint loads the `mysql2` driver installed by your application.

## Public entrypoints

- `@typed-sql/mysql` — `sql`, dialect factory, default type policy, analysis, and type mapping.
- `@typed-sql/mysql/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/mysql/mysql2` — schema provider, executable database adapter, and lazy live verifier for application-owned `mysql2`.

## Supported SQL

The grammar targets MySQL 8.4 LTS and supports:

- aliases, stars, and inner, outer, or cross joins;
- CTEs and derived or correlated subqueries;
- grouping, aggregates, windows, and `CASE`;
- scalar, `EXISTS`, `IN`, and `BETWEEN` expressions;
- common JSON functions and operators;
- `INSERT`, `UPDATE`, and `DELETE` command typing;
- ordered parameters inferred from comparisons, DML targets, casts, ranges, limits, and cataloged function arguments.

Catalog inference covers enums, unsigned integers, decimals, JSON, temporal types, binary values, and configurable `tinyint(1)` mapping.

`createMySql2LiveVerifier()` reads binary `COM_STMT_PREPARE` parameter and result metadata and closes the statement without executing it or sending values. See [Live verification](../guides/live-verification.md).

Recursive CTE inference, `FULL JOIN`, array constructors, aggregate `FILTER`, and incompatible `RETURNING` clauses produce `TSQ401`. Commands without a result surface infer `Query<never, Parameters>`. Unknown functions warn and infer `unknown`; ambiguous or structurally unsafe queries are errors.

## Runtime behavior

The adapter controls mysql2 options that affect row shape and decoding. Supplying conflicting `poolConfig` options such as `typeCast`, `rowsAsArray`, or incompatible bigint, decimal, date, or JSON settings fails before a pool is created. Connection, TLS, timeout, and pool-capacity settings remain application-owned.

`database.prepare(name, factory)` returns ordinary queries carrying instance-local prepared metadata. MySQL execution uses mysql2's `execute()` path and its per-connection prepared-statement cache. The factory caches its first structural SQL skeleton and rejects duplicate names or structural drift between calls.

`database.batch(queries)` leases one mysql2 connection and calls `execute()` sequentially for every query, preserving mysql2's per-connection prepared cache and typed-sql's result decoding. It is not a multi-statement string or one protocol round trip. Root batches use ordinary autocommit behavior. Transactional statements can use an explicit typed-sql transaction when atomicity is required; MySQL operations that implicitly commit, such as DDL, retain their native semantics.

`all`, `one`, and `maybeOne` accept an `AbortSignal` and absolute deadline. mysql2 has no per-command `AbortSignal` contract, so typed-sql interrupts a buffered query by destroying its checked-out connection. The pool replaces it for later work, while a cancelled transaction is invalidated and cannot continue.

The runtime constructors and mysql2 adapter accept a grammar-neutral `observer`. Query, prepared-query, batch, stream, cancellation, and nested-transaction lifecycles carry MySQL compiler-compatible fingerprints without exposing SQL or values. See [Observe database work](../guides/observability.md).

## Streaming

MySQL streaming uses mysql2's protocol-backed execute stream and does not require another package. `batchSize` maps to the object-mode high-water mark, so it controls client-side buffering rather than server cursor page size.

An early `break`, `close()`, or async disposal stops delivering rows to the consumer, then waits for mysql2 to drain the remaining protocol response before releasing the connection. It does not claim to cancel the running MySQL statement. A connection is reused only after the native command finishes successfully; protocol failures keep it out of the reusable pool path.

Inside a transaction, the stream reuses the transaction connection and never releases it directly. The stream must complete or close before the transaction callback returns.

See [Execute queries](../guides/execution.md), [Database type mappings](../reference/type-mappings.md#mysql), and [Compatibility](../reference/compatibility.md).
