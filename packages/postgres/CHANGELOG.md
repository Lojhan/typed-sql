# @typed-sql/postgres

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
