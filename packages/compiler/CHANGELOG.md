# @typed-sql/compiler

## 2.4.0-rc.0

### Minor Changes

- ae6a3c0: Add a stable shared build and test integration package with independent optional host entrypoints, offline SQL-file compilation, inline execution plans, source maps, dependency-aware caches, and co-located SQL declarations.

  Support Vite/Vitest, Jest with delegated transformers, webpack/Rspack/Rsbuild, Next.js, esbuild, Rollup/Rolldown, Bun, and native Node preloads. Share SQL-file compilation in the stable compiler, allow runtime-owned configuration importers, and retain the experimental bridge's existing Vite and Node entrypoints as forwards to the stable implementations.

## 2.3.0

### Minor Changes

- f51b53d: Preserve precise result types for mapped scalar IN lists and scalar INSERT VALUES rows when the selected grammar proves result independence. Keep other repeated expressions conservative, scope cached analysis to its repeated ranges, map result-column locations through expanded SQL, and consume each SQL list delimiter explicitly.
- 0d571df: Check complete TypeScript projects with in-memory inferred SQL types shared across application imports. File checks also analyze imported query modules, and native TypeScript diagnostics map back to original source positions. Add visible inferred contracts with `--show-types`, make generated check scripts usable, and include Node typings in new setup plans.

### Patch Changes

- Updated dependencies [b5808b9]
- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0
  - @typed-sql/schema@2.3.0

## 2.3.0-rc.2

### Minor Changes

- f51b53d: Preserve precise result types for mapped scalar IN lists and scalar INSERT VALUES rows when the selected grammar proves result independence. Keep other repeated expressions conservative, scope cached analysis to its repeated ranges, map result-column locations through expanded SQL, and consume each SQL list delimiter explicitly.
- 0d571df: Check complete TypeScript projects with in-memory inferred SQL types shared across application imports. File checks also analyze imported query modules, and native TypeScript diagnostics map back to original source positions. Add visible inferred contracts with `--show-types`, make generated check scripts usable, and include Node typings in new setup plans.

### Patch Changes

- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
  - @typed-sql/core@2.3.0-rc.2
  - @typed-sql/schema@2.3.0-rc.2

## 2.3.0-rc.1

### Patch Changes

- Updated dependencies [b5808b9]
  - @typed-sql/core@2.3.0-rc.1
  - @typed-sql/schema@2.3.0-rc.1

## 2.3.0-rc.0

### Minor Changes

- b24279d: Carry immutable grammar-owned value plans into portable execution, validate JSON representations and reject incompatible transport policies before dispatch. Build transforms can request executable metadata while typechecking overlays retain their existing behavior.

### Patch Changes

- b24279d: Prepare executable query value plans once per module and reuse them across inline query factory calls while preserving directive prologues, original diagnostic locations, and per-call parameter values.
- b24279d: Preserve hashbangs terminated by any JavaScript line terminator when hoisting runtime plans, and analyze CR/CRLF template content using JavaScript's cooked newline semantics.
- b24279d: Reject executable metadata transforms when the query structure cannot receive a runtime value plan, preventing unvalidated application JSON declarations from producing optimistic build output.
- 702bc16: Skip optimizer-plan capture for runtime-sized mapped fragment-list queries with an explicit
  `repeated-fragment-cardinality` reason. Their compiler SQL represents a list shape for analysis,
  not a measured runtime cardinality, so its plan must not satisfy budgets for arbitrary list sizes.
  Plan review reports these queries as unavailable and honors uncertainty failure policy.
- 19f37d9: Verify PostgreSQL decoded JSON using native wire types without claiming independent nested shape evidence. Bind fresh and cached native proofs to the effective decoding policy, and consistently include dialect factory defaults in manifest and repeated-fragment identities. Regenerate manifests and verification proofs created with the previous default-policy identity.
- b24279d: Verify executable value plans against bounded conditional and repeated query structures. Preserve validators when composing queries, require fresh metadata for changed SQL, and route generated runtime imports through the selected grammar entrypoint.
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
- Updated dependencies [b24279d]
- Updated dependencies [19f37d9]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
  - @typed-sql/core@2.3.0-rc.0
  - @typed-sql/schema@2.3.0-rc.0

## 2.2.0

This release promotes the changes documented in 2.2.0-rc.0 to stable.

### Patch Changes

- @typed-sql/core@2.2.0
  - @typed-sql/schema@2.2.0

## 2.2.0-rc.0

### Patch Changes

- b752fde: Index source-analysis offsets and bindings once and bound name-suggestion edit-distance work while preserving query ranges and suggestion tie ordering.
- 7e94958: Make schema and policy hash ordering independent of the host locale, including unordered v2 semantic arrays. Add content-checking compatibility helpers so legacy hashes remain accepted in their originating locale.
- a4c4e73: Reuse stateless character predicates during source binding scans without changing whitespace or range behavior.
- Updated dependencies [b752fde]
- Updated dependencies [456fa7f]
- Updated dependencies [7e94958]
- Updated dependencies [2f5f6be]
- Updated dependencies [71a169f]
- Updated dependencies [d176673]
  - @typed-sql/core@2.2.0-rc.0
  - @typed-sql/schema@2.2.0-rc.0

## 2.1.0

### Minor Changes

- 1041bfa: Add the versioned, serializable source-analysis service shared by batch checks and editor tooling.
  Results carry deterministic source, project, schema, type-policy, grammar, and capability identities;
  cancellation and source, query-count, structural-variant, and generated-declaration limits fail closed.
- 1041bfa: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 1041bfa: Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
  neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
  Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
  verification proofs, and plan artifacts bind to the schema format and canonical hash.
- 1041bfa: Reject unsupported TypeScript compiler and preview patches before project work begins. Add
  `typed-sql doctor` with human and JSON reports for Node.js, TypeScript, grammar, schema, redacted
  server evidence, language-server/bridge metadata, and editor protocol compatibility.
- 1041bfa: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- 1041bfa: Add a grammar-neutral serialized artifact compatibility identity and deterministic compatibility outcomes, and use the shared identity contract for query-manifest cache reuse.
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
  - @typed-sql/schema@2.1.0

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 58bd4d1: Add the versioned, serializable source-analysis service shared by batch checks and editor tooling.
  Results carry deterministic source, project, schema, type-policy, grammar, and capability identities;
  cancellation and source, query-count, structural-variant, and generated-declaration limits fail closed.
- e433feb: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 1c64475: Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
  neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
  Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
  verification proofs, and plan artifacts bind to the schema format and canonical hash.
- 4a12de5: Reject unsupported TypeScript compiler and preview patches before project work begins. Add
  `typed-sql doctor` with human and JSON reports for Node.js, TypeScript, grammar, schema, redacted
  server evidence, language-server/bridge metadata, and editor protocol compatibility.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- 58aa9ef: Add a grammar-neutral serialized artifact compatibility identity and deterministic compatibility outcomes, and use the shared identity contract for query-manifest cache reuse.
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
  - @typed-sql/schema@2.1.0-rc.0

## 2.0.0

### Major Changes

- 3f063f6: Add deterministic, secret-free query manifests with bounded structural variants, inferred result
  and parameter descriptions, semantic evidence, runtime-correlatable fingerprints, unresolved
  entries, compatible parsing, canonical serialization, incremental per-file reuse, tsconfig project
  discovery, and a dedicated CLI command.
- 6a7ae58: Add opt-in live query verification through grammar-owned PostgreSQL PREPARE and MySQL
  COM_STMT_PREPARE adapters, bounded neutral comparison, deterministic secret-free proof artifacts,
  offline cache validation, explicit unsupported classifications, CLI workflows, real database E2E,
  and performance budgets.
- 3050209: Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.
- b4f1b6e: Add deterministic migration compatibility analysis across before/after schema snapshots and query
  manifests. Reports classify both rolling-deployment directions, retain exact source and dependency
  evidence, fail closed for unknown semantics, redact defaults and paths, and support configurable CI
  severity through `typed-sql compat`.
- b2ec119: Add opt-in, grammar-neutral query-plan governance with PostgreSQL and MySQL structured EXPLAIN
  adapters, transient application-owned samples, redacted fingerprint-keyed artifacts, absolute and
  comparable regression budgets, explicit uncertainty, CLI capture and review, documentation, and
  performance coverage.

### Minor Changes

- 9c72dab: Use live MySQL catalog origins to preserve enum result evidence, and compare parameter metadata in
  the safe input direction so compiler-enforced literal subsets do not become false mismatches.

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
  - @typed-sql/schema@2.0.0

## 2.0.0-rc.1

### Minor Changes

- 9c72dab: Use live MySQL catalog origins to preserve enum result evidence, and compare parameter metadata in
  the safe input direction so compiler-enforced literal subsets do not become false mismatches.

## 2.0.0-rc.0

### Major Changes

- 3f063f6: Add deterministic, secret-free query manifests with bounded structural variants, inferred result
  and parameter descriptions, semantic evidence, runtime-correlatable fingerprints, unresolved
  entries, compatible parsing, canonical serialization, incremental per-file reuse, tsconfig project
  discovery, and a dedicated CLI command.
- 6a7ae58: Add opt-in live query verification through grammar-owned PostgreSQL PREPARE and MySQL
  COM_STMT_PREPARE adapters, bounded neutral comparison, deterministic secret-free proof artifacts,
  offline cache validation, explicit unsupported classifications, CLI workflows, real database E2E,
  and performance budgets.
- 3050209: Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.
- b4f1b6e: Add deterministic migration compatibility analysis across before/after schema snapshots and query
  manifests. Reports classify both rolling-deployment directions, retain exact source and dependency
  evidence, fail closed for unknown semantics, redact defaults and paths, and support configurable CI
  severity through `typed-sql compat`.
- b2ec119: Add opt-in, grammar-neutral query-plan governance with PostgreSQL and MySQL structured EXPLAIN
  adapters, transient application-owned samples, redacted fingerprint-keyed artifacts, absolute and
  comparable regression budgets, explicit uncertainty, CLI capture and review, documentation, and
  performance coverage.

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
  - @typed-sql/schema@2.0.0-rc.0

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
- bd26d6e: Replace potentially expensive parser regular expressions with bounded scanners, tighten editor
  completion matching, and prevent releases while high-severity CodeQL alerts remain open.
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

- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- Updated dependencies [69c7d87]
  - @typed-sql/core@1.0.0-rc.0

## 1.0.0-beta.2

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- bd26d6e: Replace potentially expensive parser regular expressions with bounded scanners, tighten editor
  completion matching, and prevent releases while high-severity CodeQL alerts remain open.
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
