# @typed-sql/build

## 3.0.0-rc.0

### Minor Changes

- 63e76b2: Load selected project catalog interpreters lazily in CLI, build and editor hosts, and carry the enriched schema through checking, transforms and declaration generation. Offline checking can reuse qualified declarations for new queries, while frozen checking requires exact contracts. Preserve base-context retirement evidence when checking derived catalog inputs, and track catalog objects and local interpreter modules as dependencies.
- 63e76b2: Consume durable query contracts in build transforms and SQL declaration generation. Frozen builds use recorded inputs without initializing analyzers or native services. Offline and live-configured builds can use offline rules for unrecorded queries; builds never invoke live factories or read the disposable development cache. Track the validated contract closure in cache keys and watched dependencies, including lazy analyzer dependencies in source-aware Jest keys, and reject inputs changed during preparation or publication.
  
  Explicit query-contract generation checks prospective SQL types over stale build-owned declarations in memory, allowing changed queries to regenerate their contracts before declarations are rewritten. Application-owned declarations and incorrect application assignments remain blocking; ordinary checks still reject stale declarations.
- 76d4cf0: Use configured offline, frozen and trusted live analysis in workspace previews, SQL tools and captured runs. Share document preparation with the editor, preserve enriched catalog schemas, and keep execution workers from initializing analyzers or native qualification adapters. PostgreSQL selected-catalog capture requests text-array namespace metadata so ordinary pg clients need no name-array parser override.

### Patch Changes

- 63e76b2: Accept current build-generated SQL declarations during project checking by sharing the declaration
  ownership header and normalizing platform line endings. Continue rejecting changed or stale
  declaration contents, including files carrying the generated ownership header.
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [4de04fc]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [825eba3]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [825eba3]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
  - @typed-sql/analysis@3.0.0-rc.0
  - @typed-sql/core@3.0.0-rc.0
  - @typed-sql/config@3.0.0-rc.0
  - @typed-sql/compiler@3.0.0-rc.0
  - @typed-sql/schema@3.0.0-rc.0

## 2.5.0

Promote the qualified `2.5.0-rc.0` candidate to stable. See that entry below for the included features and fixes.

### Patch Changes

- @typed-sql/compiler@2.5.0
  - @typed-sql/config@2.5.0
  - @typed-sql/core@2.5.0
  - @typed-sql/schema@2.5.0

## 2.5.0-rc.0

### Patch Changes

- a0c17a6: Include imported SQL assets in query manifests, live verification, plan capture and migration compatibility reports. Discover literal SQL imports from configured TypeScript projects and reject stale or missing sources.
  
  Support named SQL-file parameter objects and repeated or reordered numbered bindings. Preserve grammar-owned lexical rules, original diagnostic spans, bound-value safety and fail-closed checks for mixed styles, gaps and incompatible repeated arguments.
  
  Add explicit scalar column and domain brands through `withSchemaBrands`, `Brand` and `brandValue`. Preserve nominal identities through projections and column-context parameters while retaining primitive runtime conversion and verification contracts.
  
  Escape HTML delimiters and JavaScript line separators in generated SQL-module data literals, preserving original SQL and metadata at runtime.
- Updated dependencies [1b90678]
- Updated dependencies [81c8c46]
- Updated dependencies [0147b7a]
- Updated dependencies [a0c17a6]
- Updated dependencies [669c1b8]
  - @typed-sql/core@2.5.0-rc.0
  - @typed-sql/compiler@2.5.0-rc.0
  - @typed-sql/schema@2.5.0-rc.0
  - @typed-sql/config@2.5.0-rc.0

## 2.4.0

### Minor Changes

- Add the stable build and test integration package with optional host entrypoints, offline SQL-file compilation, inline execution plans, source maps, dependency-aware caches, and co-located SQL declarations. Support Vite/Vitest, Jest, webpack/Rspack/Rsbuild, Next.js, esbuild, Rollup/Rolldown, Bun, and native Node preloads.

### Patch Changes

- @typed-sql/compiler@2.4.0
  - @typed-sql/config@2.4.0
  - @typed-sql/core@2.4.0
  - @typed-sql/schema@2.4.0

## 2.4.0-rc.0

### Minor Changes

- ae6a3c0: Add a stable shared build and test integration package with independent optional host entrypoints, offline SQL-file compilation, inline execution plans, source maps, dependency-aware caches, and co-located SQL declarations.

  Support Vite/Vitest, Jest with delegated transformers, webpack/Rspack/Rsbuild, Next.js, esbuild, Rollup/Rolldown, Bun, and native Node preloads. Share SQL-file compilation in the stable compiler, allow runtime-owned configuration importers, and retain the experimental bridge's existing Vite and Node entrypoints as forwards to the stable implementations.

### Patch Changes

- Updated dependencies [ae6a3c0]
  - @typed-sql/compiler@2.4.0-rc.0
  - @typed-sql/config@2.4.0-rc.0
