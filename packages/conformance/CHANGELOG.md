# @typed-sql/conformance

## 2.1.1

### Patch Changes

- Updated dependencies [b752fde]
- Updated dependencies [7e94958]
- Updated dependencies [a4c4e73]
- Updated dependencies [2f5f6be]
- Updated dependencies [71a169f]
- Updated dependencies [d176673]
  - @typed-sql/compiler@2.1.1
  - @typed-sql/core@2.2.0

## 2.1.0

### Minor Changes

- 1041bfa: Add the canonical, version-aware grammar feature ledger API and fail closed for PostgreSQL-style `UPDATE FROM` and `INSERT DEFAULT VALUES` when analyzed by the MySQL grammar.
- 1041bfa: Add the published `@typed-sql/conformance/v2` feature-addressable static and live differential harness, target selection, exact-claim enforcement, reporters, fixture discovery, reduction, reproduction bundles, and a non-inflating v1 migration adapter.
- 1041bfa: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 1041bfa: Add deterministic conformance failure injection and expose the bounded config and language-server cache defaults used by reliability suites.
- 1041bfa: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- 1041bfa: Add neutral column charset and collation evidence, generated versioned MySQL built-in catalogs,
  catalog-backed type and function availability, MySQL collation coercibility, and signed/unsigned
  numeric expression resolution.
  Conformance v2 now compares grammar analysis against the neutral resolved-column contract while
  allowing grammar-owned result evidence.
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
- Updated dependencies [1041bfa]
  - @typed-sql/core@2.1.0
  - @typed-sql/compiler@2.1.0

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 1c64475: Add the canonical, version-aware grammar feature ledger API and fail closed for PostgreSQL-style `UPDATE FROM` and `INSERT DEFAULT VALUES` when analyzed by the MySQL grammar.
- 1c64475: Add the published `@typed-sql/conformance/v2` feature-addressable static and live differential harness, target selection, exact-claim enforcement, reporters, fixture discovery, reduction, reproduction bundles, and a non-inflating v1 migration adapter.
- e433feb: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 5d5d849: Add deterministic conformance failure injection and expose the bounded config and language-server cache defaults used by reliability suites.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- 0efc90c: Add neutral column charset and collation evidence, generated versioned MySQL built-in catalogs,
  catalog-backed type and function availability, MySQL collation coercibility, and signed/unsigned
  numeric expression resolution.
  Conformance v2 now compares grammar analysis against the neutral resolved-column contract while
  allowing grammar-owned result evidence.
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
- Updated dependencies [4a12de5]
- Updated dependencies [1c64475]
  - @typed-sql/core@2.1.0-rc.0
  - @typed-sql/compiler@2.1.0-rc.0

## 2.0.0

### Major Changes

- 58297bf: Publish the versioned public grammar conformance kit with typed fixture builders, required inference
  probes, explicit capability suites, fail-closed semantics, structural variants, driver-free runtime
  adapter and codec assertions, and normalized performance evidence.

### Patch Changes

- Updated dependencies [7ea5d2f]
- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [b06fd0a]
- Updated dependencies [9c72dab]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0
  - @typed-sql/compiler@2.0.0

## 2.0.0-rc.1

### Patch Changes

- Updated dependencies [9c72dab]
  - @typed-sql/compiler@2.0.0-rc.1

## 2.0.0-rc.0

### Major Changes

- 58297bf: Publish the versioned public grammar conformance kit with typed fixture builders, required inference
  probes, explicit capability suites, fail-closed semantics, structural variants, driver-free runtime
  adapter and codec assertions, and normalized performance evidence.

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
  - @typed-sql/compiler@2.0.0-rc.0

## 1.0.0

### Major Changes

- Publish the versioned public grammar conformance contract.
