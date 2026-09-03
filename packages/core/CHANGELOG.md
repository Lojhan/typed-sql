# @typed-sql/core

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 58bd4d1: Add the versioned, serializable source-analysis service shared by batch checks and editor tooling.
  Results carry deterministic source, project, schema, type-policy, grammar, and capability identities;
  cancellation and source, query-count, structural-variant, and generated-declaration limits fail closed.
- 58aa9ef: Add a grammar-neutral serialized artifact compatibility identity and deterministic compatibility outcomes, and use the shared identity contract for query-manifest cache reuse.
- 65b662f: Add structured opt-in debug events and confirmed support-bundle generation with privacy-safe default redaction.
- e433feb: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 0efc90c: Add neutral column charset and collation evidence, generated versioned MySQL built-in catalogs,
  catalog-backed type and function availability, MySQL collation coercibility, and signed/unsigned
  numeric expression resolution.
  Conformance v2 now compares grammar analysis against the neutral resolved-column contract while
  allowing grammar-owned result evidence.
- 6f5b977: Resolve PostgreSQL operators and snapshot v2 routines through a grammar-owned candidate selector
  that uses canonical types, cast contexts, preferred categories, unknown-literal rules, domains,
  arrays, ranges, enums, and the `anyelement` and `anycompatible` polymorphic families.
  Named, defaulted, expanded-variadic, and explicit-variadic routine calls now select against snapshot
  argument evidence, while known invalid explicit casts produce a stable diagnostic.
  The versioned core catalog now recognizes PostgreSQL temporal, bit-string, network, geometric,
  full-text, XML, range, multirange, object-identifier, and related scalar types. Unary numeric and
  bitwise operators, plus binary integer and bit-string operators, now resolve through typed
  candidates and reject invalid operands. Date, timestamp, time, and interval arithmetic now uses
  asymmetric PostgreSQL signatures, with parameter inference deferred until candidate selection.
  Built-in range/multirange containment and arithmetic, network containment and address arithmetic,
  full-text search composition, JSON-path predicates and deletion, and their multi-character tokens
  now use exact grammar-owned signatures.
  Geometric transformation, position, intersection, distance, containment, and relationship operators
  now resolve through their exact operand and result signatures, including prefix forms.
  Numeric promotion, mathematical prefix, bit-string shift, binary/JSON/text concatenation, money,
  `pg_lsn`, and tuple-identifier operators now use catalog-derived signatures and coercions.
  Array subscripts infer nullable element types, slices preserve the array type, omitted bounds are
  represented explicitly, index parameters infer `integer`, and nested array mappings retain every dimension.
  `ANY`, `SOME`, and `ALL` comparisons now resolve array elements or single-column subqueries through
  the operator catalog, while row comparisons validate arity and select an operator for each field pair.
  Parenthesized composite field selection now uses snapshot v2 field evidence for its database type,
  TypeScript type, nullability, parameter context, and unknown-field diagnostics.
  `COLLATE` now preserves collatable expression types, and `AT TIME ZONE` resolves PostgreSQL's exact
  timestamp, timestamp-with-time-zone, and time-with-time-zone conversions with text or interval zones.
  PostgreSQL 17 and newer also resolve and version-gate the corresponding `AT LOCAL` forms.
  Scalar and row-valued `IN` lists and subqueries now validate equality candidates, numeric literals,
  row arity, composite field comparability, nullability, and per-position parameter contexts.
  The versioned cast catalogs now include every direct `pg_cast` conversion among shipped core types
  for PostgreSQL 14 through 18, including the PostgreSQL 15 geometric removal and PostgreSQL 18
  integer/bytea additions. Automatic assignment-to-string and explicit string I/O casts follow the
  server's fallback conversion rules.
  PostgreSQL interval literals now parse prefix precision, every valid field and field-range qualifier,
  suffix second precision, and qualified interval cast types while retaining typed-literal source spans.
  All forms resolve through the canonical `interval` type, and invalid field ranges fail during parsing.
  JSON, JSONB, and JSONPATH typed literals now preserve their grammar-owned cast form. The core catalog
  and resolver cover `jsonb_path_exists`, `jsonb_path_match`, query-array, query-first, and set-returning
  query variants, including timezone-aware forms, optional variables/silent arguments, and nullability.
  Database parameter identities are now retained even when their configured TypeScript mapping is
  `unknown`, so JSON and other deliberately opaque codecs still produce typed prepared parameters.
  PostgreSQL 17 and newer now parse and resolve the grammar-owned `JSON_EXISTS` SQL/JSON expression,
  including formatted inputs, `PASSING` variables, error behavior, parameter identities, nullability,
  and server-version diagnostics.
  The grammar-owned PostgreSQL 17 `JSON_QUERY` form also resolves returning types, JSON output formats,
  wrapper and quote behavior, constant `ON EMPTY` and `ON ERROR` defaults, and exact output nullability.
  PostgreSQL 17 `JSON_VALUE` now resolves scalar return types and behaviors while preserving its
  always-possible SQL null result for JSON null and rejecting unsupported collection or format clauses.
  PostgreSQL 16 and newer now parse and resolve the standard `JSON_OBJECT` and `JSON_ARRAY`
  constructors, including key/value and query forms, null handling, unique-key declarations, formatted
  inputs, encoded returns, parameter identities, non-null output types, and server-version diagnostics.
  Legacy and quoted `json_object(...)` calls remain ordinary catalog-backed routine calls.
  PostgreSQL 17 and newer also own `JSON`, `JSON_SCALAR`, and `JSON_SERIALIZE`, including JSON-compatible
  inputs, uniqueness declarations, scalar and composite conversion, string or binary returns, UTF-8
  encoding, parameter inference, null propagation, and version diagnostics. The overlapping pre-17
  functional `json(...)` cast keeps its earlier cast semantics.
  PostgreSQL 16 and newer now own `IS JSON` and `IS NOT JSON` predicates across value, scalar,
  array, object, and unique-key constraints, with JSON-compatible input validation, text parameter
  inference, SQL-null propagation, and server-version diagnostics.
  PostgreSQL 16 and newer now also own the standard `JSON_OBJECTAGG` and `JSON_ARRAYAGG` grammar,
  including null and uniqueness clauses, aggregate-local ordering, `FILTER`, `OVER`, formatted inputs,
  encoded returns, grouping validation, parameter inference, nullable empty-input results, and
  server-version diagnostics.
  PostgreSQL 17 `JSON_TABLE` now owns its table-reference grammar and resolves root, ordinality,
  scalar, formatted, `EXISTS`, and nested columns with implicit lateral scope, alias lists, declared
  types, behavior validation, nested null-padding, and server-version diagnostics.

  Expose optional routine argument names and default evidence through the neutral resolver bridge so
  grammar packages can implement named, defaulted, and variadic call selection.
- 1c64475: Complete PostgreSQL DML parsing and analysis for identity overriding, `ON CONFLICT` targets and the
  `excluded` namespace, row assignments, source-aware update/delete returning, versioned `MERGE`, and
  PostgreSQL 18 old/new `RETURNING` aliases. Version-dependent forms now use server-major evidence and
  fail closed when that evidence is absent or outside the feature's supported range. Snapshot v2 index
  evidence now verifies expression, operator-class, collation, and partial-predicate conflict targets,
  while insert/select, update, and merge writes propagate parameter types and reject known-incompatible
  source types.

  The neutral resolver snapshot bridge now exposes optional index and constraint-deferrability evidence
  so grammar packages can consume schema v2 conflict-target metadata without importing schema internals.
- 1c64475: Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
  neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
  Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
  verification proofs, and plan artifacts bind to the schema format and canonical hash.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- ff0e3bb: Harden PostgreSQL execution with policy-owned scalar and array codecs, runtime extension codec OID
  resolution, generated-snapshot compatibility checks, bounded per-connection prepared-statement
  caches with schema and search-path invalidation, and structured driver failure classifications.
  Keep the shared `TSQ230` diagnostic registry text grammar-neutral.
- 1c64475: Resolve SQLite core built-ins, operators, coercions, arities, nullability, and in-band function
  release boundaries from SQLite-owned catalog data. Add a stable diagnostic for invalid SQLite
  built-in invocations and fail closed when version-gated functions lack usable server evidence.

## 2.0.0

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
