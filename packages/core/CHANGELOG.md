# @typed-sql/core

## 2.0.0-rc.2

### Patch Changes

- 7ea5d2f: Match the Standard Schema V1 optional-property contract under `exactOptionalPropertyTypes` so
  unwrapped Zod, Valibot, and other conforming validators are accepted directly.

## 2.0.0-rc.1

### Patch Changes

- Publish the coherent 2.0.0-rc.1 release-candidate train.

## 2.0.0-rc.0

### Major Changes

- 29afc3d: Add conservative semantic primary/replica routing over application-owned databases, scoped
  read-after-write pinning, explicit role requirements, stable unsafe-route errors, dialect runtime
  semantic resolvers, and bounded abortable transaction retry policies with native PostgreSQL and
  MySQL error classifiers. Parse and classify dialect locking reads so uncertain or affine work
  always fails closed to primary.
- 3f063f6: Add deterministic, secret-free query manifests with bounded structural variants, inferred result
  and parameter descriptions, semantic evidence, runtime-correlatable fingerprints, unresolved
  entries, compatible parsing, canonical serialization, incremental per-file reuse, tsconfig project
  discovery, and a dedicated CLI command.
- 6a7ae58: Add opt-in live query verification through grammar-owned PostgreSQL PREPARE and MySQL
  COM_STMT_PREPARE adapters, bounded neutral comparison, deterministic secret-free proof artifacts,
  offline cache validation, explicit unsupported classifications, CLI workflows, real database E2E,
  and performance budgets.
- b06fd0a: Add grammar-neutral optional adapter capability discovery, typed PostgreSQL COPY import and export
  through application-owned `pg-copy-streams`, and typed MySQL LOAD DATA import through mysql2's
  application-owned infile stream. Bulk transfers preserve ordinary `INSERT` parameter evidence,
  enforce structural row stability, apply bounded backpressure, support cancellation and progress,
  and integrate with transaction ownership and conservative connection cleanup.
- 3050209: Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.
- 1b054b6: Add an adapter-neutral, redacted database observation lifecycle for queries, cardinality contracts,
  batches, PostgreSQL pipelines, streams, cancellation, and nested transactions. Runtime fingerprints
  correlate with compiler structural variants while SQL, parameter values, connection configuration,
  and driver causes remain excluded by default. Publish the optional OpenTelemetry bridge with current
  database semantic conventions and explicit high-cardinality or exception-capture opt-ins.
- b4f1b6e: Add deterministic migration compatibility analysis across before/after schema snapshots and query
  manifests. Reports classify both rolling-deployment directions, retain exact source and dependency
  evidence, fail closed for unknown semantics, redact defaults and paths, and support configurable CI
  severity through `typed-sql compat`.
- 87189c3: Add grammar-neutral `all`, `one`, and `maybeOne` execution with exact row types, stable cardinality
  and cancellation errors, explicit adapter capabilities, AbortSignal support, and absolute deadlines.
  The pg and mysql2 adapters conservatively discard interrupted connections, including transaction
  leases, while the existing uncontrolled `execute` path remains unchanged.
- e654fae: Add opt-in Standard Schema V1 result validation with compile-time output compatibility, immutable
  query attachment, sync and async validators, redacted fingerprinted errors, and consistent decoded-row
  handling across buffered cardinality methods, batches, PostgreSQL pipelines, streams, and transactions.
- b2ec119: Add opt-in, grammar-neutral query-plan governance with PostgreSQL and MySQL structured EXPLAIN
  adapters, transient application-owned samples, redacted fingerprint-keyed artifacts, absolute and
  comparable regression budgets, explicit uncertainty, CLI capture and review, documentation, and
  performance coverage.

## 1.0.0

### Major Changes

- 7ca256b: Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Minor Changes

- eb16de7: Add grammar-neutral stream and ordered-result type contracts, and add lazy prepared-query factories to the PostgreSQL and MySQL runtime adapters. Prepared factories retain exact query types, validate stable SQL shapes, and remain available inside nested transactions.
- b6389e4: Cache immutable SQL rendering skeletons for prepared query factories so repeated calls only bind changing values while still rejecting structural drift before driver dispatch.
- eb16de7: Add a grammar-neutral validated query-batch type and ordered, exactly typed query batches to the
  PostgreSQL and MySQL runtime adapters. Non-empty root batches execute sequentially on one leased
  connection, transaction batches reuse their transaction connection, and empty batches avoid
  connection acquisition. Batch execution preserves prepared metadata and adapter codecs, stops at
  the first failure, and rejects transaction work that escapes its callback.

### Patch Changes

- b6389e4: Reuse immutable SQL text segments and whole interpolation-free fragments at template callsites, and avoid spread allocations while composing predicates, joins, and appended queries.
- eb16de7: Allow adapters to retain enriched capabilities in transaction callbacks and nested transactions
  through a self-typed core database contract. Transaction cleanup now also preserves the original
  operation error when rollback or connection-release cleanup fails.
- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- 9dd6bc4: Finalize dialect contract version 3 with explicit identifier quoting and grammar-owned capability
  declarations. Accept third-party snapshot dialects, validate grammar versions, and document the
  public grammar-authoring and conformance workflow.
- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- 3e2c75c: Infer ordered query parameter tuples and let TypeScript reject interpolation values that do not
  match their SQL context. Dialect contract version 2 adds explicit parameter analysis; unresolved
  positions remain `unknown`. Add typed nullable predicate composition through `sql.fragment()`,
  `sql.and()`, `sql.or()`, `sql.where()`, and `sql.append()` while preserving row and parameter tuples.
  Direct append fragments are grammar-analyzed cumulatively against their static base, so TypeScript
  rejects fragment interpolation values that disagree with the referenced database columns.
  Add `sql.empty` and SQL-template-native conditional structural fragments. The compiler analyzes
  complete branch variants, preserves literal boolean-dependent result rows, and type-checks nested
  fragment parameters without adding a query-builder DSL. Bound independent structural expansion at
  64 variants by default, correlate repeated conditions, merge diagnostics and fragment expectations
  across variants, and fail closed on incompatible contexts. Share indexed catalog and conservative
  parameter-resolution primitives across grammars, harden cooked-template scanning, and add runtime,
  resolver, scanner, and structural performance gates.

## 1.0.0-rc.0

### Patch Changes

- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.

## 1.0.0-beta.2

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- 9dd6bc4: Finalize dialect contract version 3 with explicit identifier quoting and grammar-owned capability
  declarations. Accept third-party snapshot dialects, validate grammar versions, and document the
  public grammar-authoring and conformance workflow.
- 3e2c75c: Infer ordered query parameter tuples and let TypeScript reject interpolation values that do not
  match their SQL context. Dialect contract version 2 adds explicit parameter analysis; unresolved
  positions remain `unknown`. Add typed nullable predicate composition through `sql.fragment()`,
  `sql.and()`, `sql.or()`, `sql.where()`, and `sql.append()` while preserving row and parameter tuples.
  Direct append fragments are grammar-analyzed cumulatively against their static base, so TypeScript
  rejects fragment interpolation values that disagree with the referenced database columns.
  Add `sql.empty` and SQL-template-native conditional structural fragments. The compiler analyzes
  complete branch variants, preserves literal boolean-dependent result rows, and type-checks nested
  fragment parameters without adding a query-builder DSL. Bound independent structural expansion at
  64 variants by default, correlate repeated conditions, merge diagnostics and fragment expectations
  across variants, and fail closed on incompatible contexts. Share indexed catalog and conservative
  parameter-resolution primitives across grammars, harden cooked-template scanning, and add runtime,
  resolver, scanner, and structural performance gates.

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.
