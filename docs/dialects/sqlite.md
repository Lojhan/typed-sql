---
title: SQLite
description: SQLite dynamic typing, STRICT tables, catalog introspection, and the optional node:sqlite adapter.
---

# SQLite

`@typed-sql/sqlite` is the preview SQLite grammar. It keeps SQLite's dynamic type system honest,
introspects real database files or in-memory databases, and exposes the built-in Node client only
through `@typed-sql/sqlite/node-sqlite`.

## Public entrypoints

- `@typed-sql/sqlite` — `sql`, dialect factory, snapshot types, type policy, and introspection over an injected queryable.
- `@typed-sql/sqlite/runtime` — driver-neutral rendering and executable adapter contracts.
- `@typed-sql/sqlite/node-sqlite` — lazy `node:sqlite` loading, schema provider, and executable database adapter.

The package has no dependency, optional dependency, or peer dependency on an SQLite driver.
`node:sqlite` is part of Node itself. The adapter requires a Node release that provides
`StatementSync.iterate()`; use Node 22.13 or newer.

## Dynamic typing and STRICT tables

SQLite associates a storage class with each value, not with its containing column. A declared type
on an ordinary table supplies affinity but does not prevent values of other storage classes. The
default policy therefore maps a non-STRICT column to the sound storage union:

```ts
bigint | number | string | Uint8Array | null
```

`null` is omitted when the catalog proves `NOT NULL`. This is deliberately wider than the column's
declared affinity. Set `flexible: "unknown"` to make ordinary-table values fully opaque.

STRICT tables enforce the SQLite type names `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, and `ANY`.
Those columns receive precise types, except `ANY`, which retains the flexible union. The default
integer policy uses `bigint`; the Node adapter calls `setReadBigInts(true)` on every prepared
statement so runtime values match inference.

## Introspection

The provider uses `PRAGMA table_list`, `table_xinfo`, `index_list`, `index_xinfo`, and
`foreign_key_list`. Snapshots preserve:

- tables, views, virtual tables, and attached schema names;
- STRICT and `WITHOUT ROWID` flags;
- normal, generated, and hidden columns;
- defaults, nullability, and primary-key position;
- unique, partial, expression, and primary-key indexes;
- grouped composite foreign keys;
- explicitly configured application functions.

Application-defined functions must be supplied with their argument types, return type,
nullability, and volatility. SQLite's catalog cannot prove those TypeScript contracts by itself.

## SQL coverage

The preview grammar supports SELECTs, aliases, inner and outer joins, CTEs, derived and correlated
subqueries, grouping, windows, aggregate `FILTER`, CASE expressions, casts, JSON operators, compound
`UNION`/`INTERSECT`/`EXCEPT` queries, ordered parameters, and `INSERT`/`UPDATE`/`DELETE RETURNING`.

Recursive CTE inference remains conservative. PostgreSQL-only `DISTINCT ON`, array constructors,
and SELECT locking clauses fail closed. Unknown functions infer `unknown` unless they are configured
in the snapshot.

## Runtime behavior

The Node adapter keeps a bounded LRU of native prepared statements. `database.prepare()` also
freezes the typed-sql structural shape, so later factory calls may change values but not SQL
structure. `batch()` executes queries sequentially on the same connection. Use an explicit
transaction when the batch must be atomic.

Transactions use `BEGIN` at the root and savepoints when nested. A root operation queue keeps
ordinary calls from accidentally entering an active transaction. Streams wrap the native
synchronous iterator in the common async iterator contract and hold exclusive connection ownership
until exhaustion or `close()`. On Node.js 22.11 and 22.12, where `StatementSync.iterate()` is not
available yet, the adapter preserves the stream contract with a buffered `all()` iterator. Node.js
22.13 and newer use the native iterator. `batchSize` is validated for API portability but does not
create server-side pages in an embedded database.

`node:sqlite` is synchronous and can block the Node event loop during database work. The adapter
does not claim cancellation or deadline support. For write-heavy or latency-isolated services,
choose an adapter backed by the worker or process model owned by your application.

SQLite support remains experimental while real-world schemas exercise these contracts. The
compiler, CLI, generated snapshot format, and grammar conformance contract are the same ones used by
the stable PostgreSQL and MySQL packages.
