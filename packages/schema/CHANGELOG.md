# @typed-sql/schema

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 1c64475: Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
  neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
  Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
  verification proofs, and plan artifacts bind to the schema format and canonical hash.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- Updated dependencies [58bd4d1]
- Updated dependencies [58aa9ef]
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

## 2.0.0

### Minor Changes

- 3050209: Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.

## 2.0.0-rc.1

### Patch Changes

- Publish the coherent 2.0.0-rc.1 release-candidate train.

## 2.0.0-rc.0

### Minor Changes

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
- 9dd6bc4: Finalize dialect contract version 3 with explicit identifier quoting and grammar-owned capability
  declarations. Accept third-party snapshot dialects, validate grammar versions, and document the
  public grammar-authoring and conformance workflow.
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
- 9dd6bc4: Finalize dialect contract version 3 with explicit identifier quoting and grammar-owned capability
  declarations. Accept third-party snapshot dialects, validate grammar versions, and document the
  public grammar-authoring and conformance workflow.

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.
