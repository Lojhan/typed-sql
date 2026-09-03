# @typed-sql/postgres

## 2.1.0-rc.1

### Patch Changes

- af8882c: Preserve domain evidence from legacy snapshots and schema-qualified v2 introspection during PostgreSQL operator resolution so parameters compared with domain-typed columns retain their inferred base type.

## 2.1.0-rc.0

### Minor Changes

- 1c64475: Add the grammar-neutral parser toolkit and move first-party parsing, ASTs, tokenization, and walking into each grammar package. The historical multi-dialect AST parser is isolated as a deprecated typed-sql 2.x compatibility surface for removal in 3.0.
- e433feb: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 1c64475: Complete PostgreSQL grouping-set, ordered/hypothetical aggregate, window-frame, lateral function,
  `ROWS FROM`, ordinality, table-sampling, and pagination analysis. Grouping legality, window
  inheritance and modifiers, record-returning functions, null-padded function rows, and version-stable
  query clauses now infer exact or deliberately conservative types with source diagnostics.
- 1c64475: Infer PostgreSQL `UNION`, `INTERSECT`, and `EXCEPT` rows and recursive CTE seed/member contracts,
  including PostgreSQL 14+ `SEARCH` and `CYCLE` generated columns. Invalid compound arity, missing
  `WITH RECURSIVE`, misplaced seed terms, unsafe self-reference shapes, and invalid generated-column
  references now fail closed with stable diagnostics and source spans.
- 00ee816: Add a public, versioned PostgreSQL extension manifest API for types, routines, operators, casts,
  codecs, and optional driver-neutral introspection. Manifests activate from installed extension
  version evidence, participate in fail-closed query analysis and snapshot generation, and report
  unsupported versions or conflicting declarations with stable diagnostics.
- 77355fe: Complete PostgreSQL snapshot v2 introspection evidence for partition relationships, partition
  strategies, search-path and role-scoped catalog visibility, routine parallel safety, record results,
  and distinct `anyelement` and `anycompatible` polymorphic families. The provider keeps role names
  out of serialized artifacts while making the visibility boundary explicit.
- ff0e3bb: Harden PostgreSQL execution with policy-owned scalar and array codecs, runtime extension codec OID
  resolution, generated-snapshot compatibility checks, bounded per-connection prepared-statement
  caches with schema and search-path invalidation, and structured driver failure classifications.
  Keep the shared `TSQ230` diagnostic registry text grammar-neutral.
- 1c64475: Publish the grammar-owned PostgreSQL support policy for upstream-supported majors 14 through 18,
  the exact current minor selected for each differential target, PostgreSQL 19 beta as a canary, and
  the deprecation window used when an upstream major reaches end of life.
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
- 1c64475: Add deterministic generated PostgreSQL core catalogs for every supported major and the canary.
  Type mapping, operator families, and built-in routine families now resolve from one version-selected
  catalog revision instead of parallel hard-coded resolver lists.
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

### Patch Changes

- 81b888d: Cache PostgreSQL operator and capability resolution per schema snapshot so version-complete semantic analysis remains inside the compiler performance budget.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.
- Updated dependencies [58bd4d1]
- Updated dependencies [58aa9ef]
- Updated dependencies [1c64475]
- Updated dependencies [65b662f]
- Updated dependencies [e433feb]
- Updated dependencies [0efc90c]
- Updated dependencies [ff0e3bb]
- Updated dependencies [6f5b977]
- Updated dependencies [1c64475]
- Updated dependencies [1c64475]
- Updated dependencies [1c64475]
- Updated dependencies [1c64475]
  - @typed-sql/core@2.1.0-rc.0
  - @typed-sql/ast@2.1.0-rc.0
  - @typed-sql/schema@2.1.0-rc.0

## 2.0.0

### Major Changes

- 29afc3d: Add conservative semantic primary/replica routing over application-owned databases, scoped
  read-after-write pinning, explicit role requirements, stable unsafe-route errors, dialect runtime
  semantic resolvers, and bounded abortable transaction retry policies with native PostgreSQL and
  MySQL error classifiers. Parse and classify dialect locking reads so uncertain or affine work
  always fails closed to primary.
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

- Updated dependencies [7ea5d2f]
- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [af27a0e]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0
  - @typed-sql/ast@2.0.0
  - @typed-sql/schema@2.0.0

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

- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [af27a0e]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/ast@2.0.0-rc.0
  - @typed-sql/core@2.0.0-rc.0
  - @typed-sql/schema@2.0.0-rc.0

## 1.0.0

### Major Changes

- 7ca256b: Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Minor Changes

- eb16de7: Add grammar-neutral stream and ordered-result type contracts, and add lazy prepared-query factories to the PostgreSQL and MySQL runtime adapters. Prepared factories retain exact query types, validate stable SQL shapes, and remain available inside nested transactions.
- eb16de7: Add lazy, exactly typed query streams to the PostgreSQL and MySQL runtime adapters. PostgreSQL
  uses an application-owned optional `pg-cursor` installation for bounded cursor reads. MySQL uses
  mysql2's execute-protocol stream and shared decoder plan. Both adapters enforce deterministic
  cleanup, transaction ownership, and positive safe-integer batch sizes.
- eb16de7: Add a grammar-neutral validated query-batch type and ordered, exactly typed query batches to the
  PostgreSQL and MySQL runtime adapters. Non-empty root batches execute sequentially on one leased
  connection, transaction batches reuse their transaction connection, and empty batches avoid
  connection acquisition. Batch execution preserves prepared metadata and adapter codecs, stops at
  the first failure, and rejects transaction work that escapes its callback.
- b6389e4: Add an exactly typed PostgreSQL `pipeline()` capability backed by node-postgres's documented opt-in pipeline mode. Pipelines lease one client, dispatch independent queries before awaiting their results, preserve tuple order and prepared metadata, settle every in-flight query before cleanup, and integrate with transaction rollback and non-escape guarantees without changing sequential `batch()` semantics.

### Patch Changes

- b6389e4: Cache immutable SQL rendering skeletons for prepared query factories so repeated calls only bind changing values while still rejecting structural drift before driver dispatch.
- eb16de7: Own in-flight transaction executions through settlement so unawaited work can never race commit, savepoint release, rollback, or connection release.

  The PostgreSQL adapter now also rejects pg's client-side `query_timeout` option because it can settle before the connection is safe to reuse. Root batches discard checked-out clients after query rejection, while caught transaction query, batch, and stream failures force rollback and discard the lease. Use PostgreSQL's server-enforced `statement_timeout` for statement deadlines.
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
- 642cebd: Prove and document runtime codec fidelity against live PostgreSQL and MySQL values. PostgreSQL now
  delegates non-policy OIDs to the installed pg parser table, MySQL maps BIT to Uint8Array, and the
  mysql2 adapter rejects pool settings that would contradict its type policy.
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
- Updated dependencies [eb16de7]
- Updated dependencies [b6389e4]
- Updated dependencies [eb16de7]
- Updated dependencies [b6389e4]
- Updated dependencies [eb16de7]
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [7ca256b]
- Updated dependencies [16e2475]
- Updated dependencies [69c7d87]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0
  - @typed-sql/ast@1.0.0
  - @typed-sql/schema@1.0.0

## 1.0.0-rc.0

### Patch Changes

- Updated dependencies [69c7d87]
  - @typed-sql/core@1.0.0-rc.0

## 1.0.0-beta.2

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- 9dd6bc4: Finalize dialect contract version 3 with explicit identifier quoting and grammar-owned capability
  declarations. Accept third-party snapshot dialects, validate grammar versions, and document the
  public grammar-authoring and conformance workflow.
- 642cebd: Prove and document runtime codec fidelity against live PostgreSQL and MySQL values. PostgreSQL now
  delegates non-policy OIDs to the installed pg parser table, MySQL maps BIT to Uint8Array, and the
  mysql2 adapter rejects pool settings that would contradict its type policy.
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
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0-beta.2
  - @typed-sql/ast@1.0.0-beta.2
  - @typed-sql/schema@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- Updated dependencies [16e2475]
  - @typed-sql/core@1.0.0-beta.1
  - @typed-sql/ast@1.0.0-beta.1
  - @typed-sql/schema@1.0.0-beta.1

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Patch Changes

- Updated dependencies
  - @typed-sql/ast@1.0.0-beta.0
  - @typed-sql/core@1.0.0-beta.0
  - @typed-sql/schema@1.0.0-beta.0
