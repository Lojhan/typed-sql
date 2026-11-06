# @typed-sql/build

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
