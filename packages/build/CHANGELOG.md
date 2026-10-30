# @typed-sql/build

## 2.4.0-rc.0

### Minor Changes

- ae6a3c0: Add a stable shared build and test integration package with independent optional host entrypoints, offline SQL-file compilation, inline execution plans, source maps, dependency-aware caches, and co-located SQL declarations.
  
  Support Vite/Vitest, Jest with delegated transformers, webpack/Rspack/Rsbuild, Next.js, esbuild, Rollup/Rolldown, Bun, and native Node preloads. Share SQL-file compilation in the stable compiler, allow runtime-owned configuration importers, and retain the experimental bridge's existing Vite and Node entrypoints as forwards to the stable implementations.

### Patch Changes

- Updated dependencies [ae6a3c0]
  - @typed-sql/compiler@2.4.0-rc.0
  - @typed-sql/config@2.4.0-rc.0
