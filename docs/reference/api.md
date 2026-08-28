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
- `compileQueryRenderSkeleton(query, renderer)` produces the first rendering and an immutable, renderer-specific structural plan for adapter caches.
- `bindQueryRenderSkeleton(query, skeleton)` binds values to that plan, or returns `undefined` when text, identifiers, segment kinds, or segment count drift.
- `SqlRenderer` supplies grammar-specific placeholders and identifier quoting.
- `createDatabase(executor, renderer, transactionRunner)` connects the neutral query contract to a runtime adapter.
- `Database.execute()` preserves the query row type.
- `Database.all()`, `one()`, and `maybeOne()` preserve the same row type and accept optional execution controls.
- `Database.transaction()` scopes execution through the adapter's transaction runner.

Most applications use `createPgDatabase` or `createMySql2Database` rather than constructing a neutral adapter directly.

### Cardinality and execution controls

Every `Database` exposes immutable `executionCapabilities` and these grammar-neutral methods:

```ts
database.all(query, { signal?, deadline? })
database.one(query, { signal?, deadline? })
database.maybeOne(query, { signal?, deadline? })
```

`deadline` is an absolute Unix timestamp in milliseconds or a `Date`. `all()` returns `readonly Row[]`; `one()` returns `Row` and requires exactly one row; `maybeOne()` returns `Row | undefined` and permits at most one row. typed-sql does not add `LIMIT`, rewrite SQL, or infer runtime cardinality from the static query.

Cardinality failures throw `QueryCardinalityError` with code `TSQL_CARDINALITY`, `expected`, and `actual`. Cancellation throws `QueryCancelledError` with code `TSQL_CANCELLED` and reason `signal` or `deadline`. An unavailable control throws `UnsupportedExecutionCapabilityError` with code `TSQL_UNSUPPORTED_EXECUTION_CAPABILITY` before dispatch. Adapters must discard a connection when interrupting it cannot prove that connection reusable.

`execute(query)` remains the allocation-minimal compatibility path. Calling `all(query)` without a signal or deadline delegates to that same path. Execution controls apply to one buffered query; batches, pipelines, and streams keep their own lifecycle contracts.

### Prepared query factories

PostgreSQL and MySQL adapters expose:

```ts
database.prepare(name, (...arguments) => query)
```

The return value is a callable adapter-specific prepared-query factory with a readonly `statementName`. Its arguments and returned `Query<Row, Parameters>` remain exact. Calling the factory does not create a separate executable query class; it returns the ordinary `Query` produced by the callback.

Prepared names are non-empty, NUL-free, and unique within a database instance. The first call fixes the exact structural SQL skeleton for that name. Later calls with different text, identifiers, segment kinds, or segment counts throw before driver dispatch, even if an alternative segmentation could produce the same final text. Parameter values may vary because value contents are not part of the structural skeleton.

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

### PostgreSQL pipelines

The PostgreSQL database and transaction adapters expose:

```ts
database.pipeline(queries)
```

The type mapping matches `batch()`: readonly query tuples retain an exact `QueryResults<Queries>` result. The application-owned `pg` driver must be version 8.23.0 or newer, and its pool must enable the documented pipeline mode with `{ pipeline: true }`. An empty pipeline returns without leasing a connection.

Unlike sequential `batch()`, `pipeline()` dispatches every query before awaiting responses. This reduces idle network round trips for independent statements but means a later statement may execute even when an earlier one fails. typed-sql waits for all dispatched statements and reports the first rejection in input order. Root pipelines use ordinary autocommit behavior; explicit transaction pipelines use the surrounding transaction and must be awaited before its callback returns.

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

### Database observation

`DatabaseObserver` is the grammar- and adapter-neutral execution lifecycle contract. Pass an observer through `createPgDatabase`, `createMySql2Database`, or the driver-neutral runtime constructors. Applications adapting an existing pool pass the result of `adaptPgPool` or `adaptMySql2Pool` to that dialect's runtime constructor alongside the observer.

`DatabaseOperationStart` is a discriminated union for `query`, `batch`, `pipeline`, `stream`, and `transaction`. Every member contains `dialect`, `grammarVersion`, and `transactionDepth`; query-like members add structural fingerprints and execution metadata. Events do not contain SQL text, parameter values, or connection configuration.

`DatabaseObservation` can provide `run(callback)` to establish observer-owned context and must provide `end(completion)`. A completion reports `success`, `error`, or `cancelled`, a duration, and available row count or sanitized error classification. Core isolates observer start and end failures and closes accepted operations at most once.

Set `DatabaseObserver.captureErrorCause` only when an integration explicitly needs the original driver error. Causes are absent by default because driver errors can contain sensitive SQL or values.

`@typed-sql/opentelemetry` exports `createOpenTelemetryObserver(options?)`. Its OpenTelemetry API dependency is an application-owned peer. See [Observe database work](../guides/observability.md) for lifecycle ordering, redaction policy, and tracing setup.

## Configuration and schema contracts

`defineConfig()` accepts a `DialectPlugin`, schema file and provider, output directory, TypeScript projects, type policy, compiler options, optional `manifest.outFile`, optional live-verification adapter, proof path and concurrency, and optional compatibility report path and failure severity.

Public schema types include `SchemaSnapshot`, `GeneratedSchemaSnapshot`, table, column, domain, and function metadata, `SchemaProvider`, and source-mapped diagnostics.

## Compiler entrypoints

`@typed-sql/compiler` exposes a small package-root integration surface:

- `checkFile` and its option and result types;
- `compileSource` and its query or fragment results;
- `extractStaticQueries`, `extractDynamicQueries`, `mapSqlRange`, and their extracted-source types;
- `buildQueryManifest`, canonical serialization, compatible parsing, and project file enumeration;
- the query manifest format, fingerprint algorithm, and JSON Schema constants.
- live-verification candidate collection, native comparison, proof parsing and serialization, cache validation, and artifact-version constants.
- migration compatibility analysis, report parsing and serialization, before/after evidence types, classifications, deployment directions, and artifact-version constants.

Each `CompiledQuery` includes:

- `fingerprint`, a dialect- and grammar-version-scoped SHA-256 identity;
- `variantFingerprints`, containing every bounded structural SQL identity;
- `variants`, containing each fingerprint's ordered parameters, columns, branch choices, and semantics;
- `semantics`, with source-mapped, conservatively merged query evidence.

Manifest output is a compiler and CI artifact, not an application import surface. See [Query manifests](../guides/query-manifests.md) for the format, redaction boundary, incremental behavior, and CLI exit codes.

`LiveQueryVerifier` is the grammar-neutral adapter contract. PostgreSQL exposes `createPgLiveVerifier()` from `@typed-sql/postgres/pg`; MySQL exposes `createMySql2LiveVerifier()` from `@typed-sql/mysql/mysql2`. These adapters are lazy and driver-optional. See [Live verification](../guides/live-verification.md).

`analyzeSchemaCompatibility()` consumes two public `SchemaSnapshot` values and their matching query manifests. `serializeSchemaCompatibilityReport()` writes canonical JSON and `parseSchemaCompatibilityReport()` validates the versioned public artifact. See [Migration compatibility](../guides/migration-compatibility.md).

Scanner control flow, append extraction, structural parsing, branch expansion, and conditional row rendering remain internal.

## Grammar entrypoints

`@typed-sql/core` exports `DialectPlugin`, `DialectCapabilities`, `SchemaProvider`, resolution and snapshot types, `DIALECT_CONTRACT_VERSION`, `assertDialectPlugin`, and grammar-neutral resolver helpers.

Dialect contract version 4 requires every `DialectAnalysis` to include `QuerySemantics`. Its operation, cardinality, volatility, locking, and connection-affinity values carry source evidence. Dependencies record object kind, access, name, optional schema/parent, source range, and whether the reference was schema-resolved or only syntactic. `defineQuerySemantics`, `unknownQuerySemantics`, `mapQuerySemanticRanges`, and `mergeQuerySemantics` provide canonical immutability, fail-closed analysis, source mapping, and structural-composition mechanics.

See [Authoring a custom grammar](../extending/custom-grammars.md).

## Grammar conformance entrypoints

`@typed-sql/conformance` is a stable, driver-free test package for grammar authors:

- `GRAMMAR_CONFORMANCE_VERSION` versions the public fixture contract.
- `REQUIRED_GRAMMAR_PROBES` lists the inference families every grammar must exercise.
- `assertGrammarConformance(fixture)` verifies plugin, renderer, snapshot, inference, semantic,
  capability, structural-composition, and fail-closed behavior and returns an immutable report.
- `defineGrammarConformanceFixture(fixture)` preserves generic fixture types at the package boundary.
- `assertCodecConformance(fixture)` verifies representative runtime decoding cases.
- `defineCodecConformanceFixture(fixture)` defines a typed codec corpus.
- `assertRuntimeAdapterConformance(fixture)` verifies rendering, values, execution, and transaction
  dispatch through a driver-free recorder.
- `measureGrammarPerformance(options)` returns warmup-normalized p50, p95, and minimum throughput
  evidence without imposing a machine-independent budget.

The package exports its fixture, expectation, report, codec, and performance types from its root. It
does not install a SQL grammar, database driver, or test runner. See the
[conformance guide](../extending/custom-grammars.md#conformance-kit).

## Compatibility policy

Removing or incompatibly changing a documented entrypoint, runtime export, type relationship, grammar contract, or diagnostic meaning requires a major version. Additive public exports may ship in a minor version. Experimental packages may change while marked experimental but must remain compatible with the matching core and compiler train.
