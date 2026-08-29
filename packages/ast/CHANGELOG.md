# @typed-sql/ast

## 1.1.0

### Minor Changes

- 29afc3d: Add conservative semantic primary/replica routing over application-owned databases, scoped
  read-after-write pinning, explicit role requirements, stable unsafe-route errors, dialect runtime
  semantic resolvers, and bounded abortable transaction retry policies with native PostgreSQL and
  MySQL error classifiers. Parse and classify dialect locking reads so uncertain or affine work
  always fails closed to primary.
- af27a0e: Add the experimental SQLite grammar with sound flexible-table storage unions, precise STRICT-table
  types, catalog snapshots for views, generated columns, indexes, foreign keys, and attached schemas,
  compound-query and RETURNING inference, and an optional application-owned `node:sqlite` adapter for
  prepared execution, nested transactions, ordered batches, and typed streams.
- 3050209: Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.

## 1.0.0

### Major Changes

- 7ca256b: Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.

## 1.0.0-rc.0

### Patch Changes

- Publish the coherent 1.0.0-rc.0 release-candidate train.

## 1.0.0-beta.2

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.
