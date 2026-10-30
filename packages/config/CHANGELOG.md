# @typed-sql/config

## 2.4.0-rc.0

### Minor Changes

- ae6a3c0: Add a stable shared build and test integration package with independent optional host entrypoints, offline SQL-file compilation, inline execution plans, source maps, dependency-aware caches, and co-located SQL declarations.
  
  Support Vite/Vitest, Jest with delegated transformers, webpack/Rspack/Rsbuild, Next.js, esbuild, Rollup/Rolldown, Bun, and native Node preloads. Share SQL-file compilation in the stable compiler, allow runtime-owned configuration importers, and retain the experimental bridge's existing Vite and Node entrypoints as forwards to the stable implementations.

## 2.3.0

### Patch Changes

- Updated dependencies [b5808b9]
- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0

## 2.3.0-rc.2

### Patch Changes

- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0-rc.2

## 2.3.0-rc.1

### Patch Changes

- Updated dependencies [b5808b9]
  - @typed-sql/core@2.3.0-rc.1

## 2.3.0-rc.0

### Patch Changes

- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [19f37d9]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [19f37d9]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
  - @typed-sql/core@2.3.0-rc.0

## 2.2.0

This release promotes the changes documented in 2.2.0-rc.0 to stable.

### Patch Changes

- @typed-sql/core@2.2.0

## 2.2.0-rc.0

### Patch Changes

- 8e6b443: Avoid rereading unchanged imported configuration files on every project reopen. Cache content hashes behind file identity, size and nanosecond modification/change timestamps; changed or deleted imports still invalidate the configuration.
- 5387b5e: Refresh changed local configuration dependencies and recognize their editor file-watch events, while reusing unchanged evaluated configurations.
- 5c491f2: Use the exact TypeScript 7.1 beta public APIs for editor inference, including initial in-memory snapshots for unsaved documents. Update the language server protocol dependencies and configuration loader dependencies. The compiler remains on its independently verified TypeScript 7.0.2 path.
- Updated dependencies [b752fde]
- Updated dependencies [2f5f6be]
- Updated dependencies [71a169f]
- Updated dependencies [d176673]
  - @typed-sql/core@2.2.0-rc.0

## 2.1.0

### Minor Changes

- 1041bfa: Add deterministic conformance failure injection and expose the bounded config and language-server cache defaults used by reliability suites.

### Patch Changes

- 1041bfa: Reuse a bounded content-addressed config module cache so repeated project and editor lifecycles do not retain a new TypeScript loader for unchanged configuration.
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
  - @typed-sql/core@2.1.0

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 5d5d849: Add deterministic conformance failure injection and expose the bounded config and language-server cache defaults used by reliability suites.

### Patch Changes

- f902a97: Reuse a bounded content-addressed config module cache so repeated project and editor lifecycles do not retain a new TypeScript loader for unchanged configuration.
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

### Patch Changes

- Updated dependencies [7ea5d2f]
- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0

## 2.0.0-rc.1

### Patch Changes

- Publish the coherent 2.0.0-rc.1 release-candidate train.

## 2.0.0-rc.0

### Patch Changes

- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0-rc.0

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
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- Updated dependencies [16e2475]
  - @typed-sql/core@1.0.0-beta.1

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Patch Changes

- Updated dependencies
  - @typed-sql/core@1.0.0-beta.0
