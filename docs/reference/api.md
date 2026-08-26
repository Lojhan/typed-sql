---
title: Query API
description: Reference the public query, fragment, database, compiler, schema, and grammar contracts.
---

# Query API

This page describes supported package entrypoints and type relationships. Internal source modules and generated folders are not public entrypoints.

## Query types

`Query<Row, Parameters>` represents one complete statement:

- `Row` is the analyzed result row.
- `Parameters` is an ordered readonly tuple matching flattened interpolation order.
- `QueryRow<QueryValue>` extracts the row.
- `QueryParameters<QueryValue>` extracts the parameter tuple.
- `Database.execute(query)` returns `Promise<readonly Row[]>`.

`Query` is invariant in both generic positions, so it cannot be silently widened to a different row or parameter contract.

`SqlFragment<Parameters>` represents trusted static structure with its own ordered parameter tuple. `OptionalSqlFragment` also accepts `undefined`, `null`, and `false` as absent values during composition.

## The `sql` tag

Applications import `sql` from their selected dialect root.

| Member | Result | Purpose |
| --- | --- | --- |
| ``sql`...` `` | `Query<Row, Parameters>` | Define a complete static query. |
| ``sql.fragment`...` `` | `SqlFragment<Parameters>` | Mark static SQL structure while preserving nested values as parameters. |
| `sql.empty` | `SqlFragment<readonly []>` | Represent no structural content. |
| `sql.ident(name)` | `SqlFragment<readonly []>` | Quote an identifier through the selected grammar. |
| `sql.value(value)` | `SqlFragment<readonly [Value]>` | Create an explicit value fragment. |
| `sql.join(parts, separator?)` | `SqlFragment` | Join trusted fragments, using a comma separator by default. |
| `sql.and(parts)` | `SqlFragment` | Join present predicates with parenthesized `AND`. |
| `sql.or(parts)` | `SqlFragment` | Join present predicates with parenthesized `OR`. |
| `sql.where(query, predicate)` | `Query` | Preserve the base row and append predicate parameters. |
| `sql.append(query, ...parts)` | `Query` | Append present fragments while preserving ordered parameters. |
| `sql.raw(text)` | `SqlFragment<readonly []>` | Insert trusted static SQL unchanged. |
| `sql.dynamic(text)` | `Query<unknown>` | Opt out of static row inference for dynamic SQL. |

`sql.raw()` is not an escaping function. Do not pass untrusted values to it.

The declarations contain an internal `sql.__typed` member used by compiler overlays. Application code must use the ordinary `sql` tag.

## Rendering and database adapters

- `renderQuery(query, renderer)` produces SQL text and values.
- `SqlRenderer` supplies grammar-specific placeholders and identifier quoting.
- `createDatabase(executor, renderer, transactionRunner)` connects the neutral query contract to a runtime adapter.
- `Database.execute()` preserves the query row type.
- `Database.transaction()` scopes execution through the adapter's transaction runner.

Most applications use `createPgDatabase` or `createMySql2Database` rather than constructing a neutral adapter directly.

### Prepared query factories

PostgreSQL and MySQL adapters expose:

```ts
database.prepare(name, (...arguments) => query)
```

The return value is a callable adapter-specific prepared-query factory with a readonly `statementName`. Its arguments and returned `Query<Row, Parameters>` remain exact. Calling the factory does not create a separate executable query class; it returns the ordinary `Query` produced by the callback.

Prepared names are non-empty, NUL-free, and unique within a database instance. The first call fixes the exact rendered SQL text for that name. Later calls with a different rendered shape throw before driver dispatch. Parameter values may vary because they do not change rendered SQL text.

The same prepared-state registry is available to transaction scopes created by the database. A prepared query executed through another database instance is treated as an ordinary query because preparation metadata is instance-local.

### Ordered batches

PostgreSQL and MySQL database and transaction adapters expose:

```ts
database.batch(queries)
```

The input is a readonly query tuple or homogeneous query array. `QueryResults<Queries>` maps every query to its `readonly Row[]` result while preserving tuple order. Non-query values are rejected by the parameter type.

An empty batch returns without leasing a connection. A non-empty root batch leases one connection and executes each query sequentially, stopping at the first failure. It is neither atomic nor a one-round-trip protocol. Calling `batch()` inside `database.transaction()` reuses the transaction connection, so transactional statements follow the surrounding transaction's commit or rollback. Database rules such as MySQL DDL implicit commits still apply.

Transaction batches are scoped operations. Callers must await them before the callback returns, and adapters reject competing connection work while a batch is active.

Transaction `execute()` calls are scoped operations too. A callback must await every dispatched execution before returning. If execution is still in flight, the adapter waits for it to settle and rolls back instead of selecting commit or releasing the connection underneath it.

### Query streams

`QueryStream<Row>` extends `AsyncIterableIterator<Row>` and `AsyncDisposable` and adds:

```ts
close(): Promise<void>
```

PostgreSQL and MySQL database and transaction adapters expose:

```ts
database.stream(query, options?)
```

`StreamOptions` currently contains `batchSize?: number`. Adapters reject values that are not positive safe integers. `stream()` is lazy with respect to driver work: no connection is acquired before the first iteration. Natural completion, iterator return, explicit close, and async disposal perform terminal cleanup exactly once.

Transaction streams are scoped resources. They must reach completion or close before the callback returns, and an adapter rejects concurrent operations that would reuse the same transaction connection while a stream is active.

Streaming is an adapter capability rather than a method on the minimal core `Database` contract. PostgreSQL maps it to an application-owned cursor; MySQL maps it to protocol streaming. See [Execute queries](../guides/execution.md#stream-large-result-sets) for consumer examples.

## Configuration and schema contracts

`defineConfig()` accepts a `DialectPlugin`, schema file and provider, output directory, TypeScript projects, type policy, and compiler options.

Public schema types include `SchemaSnapshot`, `GeneratedSchemaSnapshot`, table, column, domain, and function metadata, `SchemaProvider`, and source-mapped diagnostics.

## Compiler entrypoints

`@typed-sql/compiler` exposes a small package-root integration surface:

- `checkFile` and its option and result types;
- `compileSource` and its query or fragment results;
- `extractStaticQueries`, `mapSqlRange`, `ExtractedQuery`, and `ExtractedInterpolation`.

Scanner control flow, append extraction, structural parsing, branch expansion, and conditional row rendering remain internal.

## Grammar entrypoints

`@typed-sql/core` exports `DialectPlugin`, `DialectCapabilities`, `SchemaProvider`, resolution and snapshot types, `DIALECT_CONTRACT_VERSION`, `assertDialectPlugin`, and grammar-neutral resolver helpers.

See [Authoring a custom grammar](../extending/custom-grammars.md).

## Compatibility policy

Removing or incompatibly changing a documented entrypoint, runtime export, type relationship, grammar contract, or diagnostic meaning requires a major version. Additive public exports may ship in a minor version. Experimental packages may change while marked experimental but must remain compatible with the matching core and compiler train.
