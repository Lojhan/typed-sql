# @typed-sql/cli

## 3.0.0

### Patch Changes

- @typed-sql/analysis@3.0.0
  - @typed-sql/compiler@3.0.0
  - @typed-sql/config@3.0.0
  - @typed-sql/core@3.0.0
  - @typed-sql/migrations@3.0.0
  - @typed-sql/schema@3.0.0

## 3.0.0-rc.0

### Minor Changes

- 63e76b2: Add read-only analysis cache inspection, CLI cache status and pruning, semantic query/declaration export diffs with JSON output and current callers, and recorded evidence origin/context in editor hovers. Cache inspection reports unverified freshness and does not initialize storage or native services.
- 4de04fc: Add explicit SQL and TypeScript migration control with independently replayed schema evidence, blocking drift detection, global/local checks, PostgreSQL locking and history, schema reconciliation, baseline adoption and inspected recovery.
- 63e76b2: Load selected project catalog interpreters lazily in CLI, build and editor hosts, and carry the enriched schema through checking, transforms and declaration generation. Offline checking can reuse qualified declarations for new queries, while frozen checking requires exact contracts. Preserve base-context retirement evidence when checking derived catalog inputs, and track catalog objects and local interpreter modules as dependencies.
- 63e76b2: Add explicit live/offline query-contract generation and check-only export comparison. Generation
  checks the prospective contract view with TypeScript and fences source/config/schema/project inputs
  before publishing a complete durable closure. Native-required qualification cannot fall back to an
  ordinary offline result.
  
  Serialize cooperating exporters, compare the selected manifest before replacement, and reject
  unsafe artifact files. Preserve recorded result kind and reject offline materialization that would
  lose logical type refinements or misrepresent partial native identity.
- 63e76b2: Add lightweight dialect registrations with explicit lazy analyzer loading and frozen CLI checks
  against validated durable query contracts. Frozen checks validate interpreter, schema, decoding and
  qualification identities without opening disposable caches, initializing analyzers or invoking
  database providers. TypeScript project checking supplies SQL-file factory declarations in memory.
  
  Expose PostgreSQL contract compatibility identities through a pure contract-profile entrypoint.
- 63e76b2: Make grammar roots lightweight entrypoints for application SQL, runtime plans, rendering and type
  policy. Keep profile construction on explicit `/profile` entrypoints. Move eager analyzer factories
  and the previous full root export surfaces to explicit `/analysis` compatibility entrypoints. Application `sql` imports stay at the
  selected grammar root. Migrate analyzer, introspection and semantic routing imports to `/analysis`,
  or register an explicit lazy analyzer loader alongside a lightweight profile for development hosts.
  
  Scaffold new projects with a lightweight profile and a separate lazy analyzer contribution.
- 825eba3: Add an optional local dev workspace with captured schema relationships, real project file editing, inferred SQL contracts, and checked TypeScript/SQL execution through explicit lazy targets. Include an application-owned PostgreSQL adapter with bounded cursor results, cancellation and read-only execution, plus loopback session protection and lossless result export. Keep query files in a repository folder across sessions, reuse the docs playground file tree and resizable split-editor interactions, page cursor results on demand without a fixed row cutoff, compare captured runs, and connect explicitly configured local ACP agents with private user configuration and reviewed repository-file proposals.
  
  Provide a headerless workspace with a command palette, editor search, layout shortcuts and theme controls. Format editor buffers through repository-configured, locally installed Biome or Prettier without automatically saving files or installing tools.
  
  Connect an optional local language-server companion for hover, completions, definitions, quick fixes and inline diagnostics with full unsaved working-copy context. Preserve TypeScript runtime import resolution across JS/TS source families and bind sanitized PostgreSQL diagnostics to proven captured SQL spans.
- 63e76b2: Add explicit live adapter registration and finite native qualification before CLI TypeScript
  checking. Qualify every extracted candidate, including successful static inference, through bounded
  workers and the persistent scheduler. Check recorded context before and after acquisition, retire
  incompatible context evidence, and close owned transport resources before synchronous compilation.
  
  Offline and frozen overrides leave native factories unloaded. Track local modules imported by
  explicit contribution factories so subsequent configuration loads detect their changes.
- 63e76b2: Support live context discovery and refresh without a pre-recorded context file. Bind recorded
  selection to the configured target, schema, installed profile and decoding policy; fence competing
  observations and retire prior query evidence when the selected epoch changes. Explicit context pins
  retain their behavior.
  
  Include target/context selection in durable manifests for offline and frozen consumption. Frozen
  checks ignore disposable observations; hybrid offline rules remain available without claiming a
  native observation. Revalidate context/query cache snapshots before publishing generated inputs.
  
  Dispose constructed native services if subsequent configuration dependency tracking fails.
- 63e76b2: Consume durable query contracts in build transforms and SQL declaration generation. Frozen builds use recorded inputs without initializing analyzers or native services. Offline and live-configured builds can use offline rules for unrecorded queries; builds never invoke live factories or read the disposable development cache. Track the validated contract closure in cache keys and watched dependencies, including lazy analyzer dependencies in source-aware Jest keys, and reject inputs changed during preparation or publication.
  
  Explicit query-contract generation checks prospective SQL types over stale build-owned declarations in memory, allowing changed queries to regenerate their contracts before declarations are rewritten. Application-owned declarations and incorrect application assignments remain blocking; ordinary checks still reject stale declarations.
- 63e76b2: Add exact recorded-context cache lookup before analyzer loading, offline contract-first project
  checking, and explicit persistent live producers. Hybrid offline checks load an analyzer only for
  uncovered statements; native-required misses and known negative evidence remain conservative.
  
  Fence cache publications across changed static claims and preserve matching recorded evidence on
  transport outages. A known stale context blocks all lookups in that recorded context until fresh
  qualified acquisition restores it. Explicit live producers always acquire independent evidence.
- 63e76b2: Persist selected catalog closures in the owned analysis cache with independent base-context and
  selection publication fences. Live editor sessions capture through a shared native owner, reuse
  valid document views, and bound refresh work, cancellation and cleanup. Offline checks recover
  matching cached selections with independently installed interpreters. Explicit live CLI checks
  can capture selected catalogs without exporting durable artifacts.
- 63e76b2: Capture and refresh selected catalogs during explicit live query generation. Keep base native identities independent of the enriched compiler schema, qualify queries against the derived context, and publish the catalog closure with query contracts. Bound retries and owned cleanup on context drift or cancellation. Hybrid live preparation retains independent offline rules for adapter-excluded statement classes; native-required qualification remains blocking.
- 63e76b2: Add `check --watch` for ordinary, offline, frozen and explicitly live query checking. Serialize
  checks, coalesce edits, reload configuration in each pass, observe discovered external inputs and
  ignore disposable cache writes without exporting tracked contracts. Stop owned discovery and
  checking processes on shutdown; TypeScript discovery accepts an optional cancellation signal.

### Patch Changes

- 63e76b2: Refresh automatically observed contexts after confirmed drift in finite live checks and generation,
  with at most three attempts sharing the existing batch deadline. Wait for owned cleanup between
  attempts, preserve explicit pins, and honor cancellation through cleanup. Watch status distinguishes
  queued edits from waiting for changes.
- 63e76b2: Report source locations and retained qualification diagnostics when native-required generation
  cannot obtain a candidate contract. The underlying classified failure is no longer hidden by
  the generic project-wide qualification error; failed generation still preserves durable inputs.
- 76d4cf0: Use configured offline, frozen and trusted live analysis in workspace previews, SQL tools and captured runs. Share document preparation with the editor, preserve enriched catalog schemas, and keep execution workers from initializing analyzers or native qualification adapters. PostgreSQL selected-catalog capture requests text-array namespace metadata so ordinary pg clients need no name-array parser override.
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
  - @typed-sql/analysis@3.0.0-rc.0
  - @typed-sql/core@3.0.0-rc.0
  - @typed-sql/migrations@3.0.0-rc.0
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

### Minor Changes

- 1e7c465: Recognize DuckDB in the nonexecuting project initialization planner.
- a0c17a6: Include imported SQL assets in query manifests, live verification, plan capture and migration compatibility reports. Discover literal SQL imports from configured TypeScript projects and reject stale or missing sources.
  
  Support named SQL-file parameter objects and repeated or reordered numbered bindings. Preserve grammar-owned lexical rules, original diagnostic spans, bound-value safety and fail-closed checks for mixed styles, gaps and incompatible repeated arguments.
  
  Add explicit scalar column and domain brands through `withSchemaBrands`, `Brand` and `brandValue`. Preserve nominal identities through projections and column-context parameters while retaining primitive runtime conversion and verification contracts.
  
  Escape HTML delimiters and JavaScript line separators in generated SQL-module data literals, preserving original SQL and metadata at runtime.
- 89d17ab: Recognize SQL Server in the nonexecuting project initialization planner.

### Patch Changes

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

### Patch Changes

- @typed-sql/compiler@2.4.0
  - @typed-sql/config@2.4.0
  - @typed-sql/core@2.4.0
  - @typed-sql/schema@2.4.0

## 2.4.0-rc.0

### Patch Changes

- Updated dependencies [ae6a3c0]
  - @typed-sql/compiler@2.4.0-rc.0
  - @typed-sql/config@2.4.0-rc.0

## 2.3.0

### Minor Changes

- 0d571df: Check complete TypeScript projects with in-memory inferred SQL types shared across application imports. File checks also analyze imported query modules, and native TypeScript diagnostics map back to original source positions. Add visible inferred contracts with `--show-types`, make generated check scripts usable, and include Node typings in new setup plans.

### Patch Changes

- Updated dependencies [b5808b9]
- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
- Updated dependencies [0d571df]
  - @typed-sql/core@2.3.0
  - @typed-sql/compiler@2.3.0
  - @typed-sql/config@2.3.0
  - @typed-sql/schema@2.3.0

## 2.3.0-rc.2

### Minor Changes

- 0d571df: Check complete TypeScript projects with in-memory inferred SQL types shared across application imports. File checks also analyze imported query modules, and native TypeScript diagnostics map back to original source positions. Add visible inferred contracts with `--show-types`, make generated check scripts usable, and include Node typings in new setup plans.

### Patch Changes

- Updated dependencies [f51b53d]
- Updated dependencies [bc4068e]
- Updated dependencies [0d571df]
  - @typed-sql/core@2.3.0-rc.2
  - @typed-sql/compiler@2.3.0-rc.2
  - @typed-sql/config@2.3.0-rc.2
  - @typed-sql/schema@2.3.0-rc.2

## 2.3.0-rc.1

### Patch Changes

- Updated dependencies [b5808b9]
  - @typed-sql/core@2.3.0-rc.1
  - @typed-sql/compiler@2.3.0-rc.1
  - @typed-sql/config@2.3.0-rc.1
  - @typed-sql/schema@2.3.0-rc.1

## 2.3.0-rc.0

### Patch Changes

- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [b24279d]
- Updated dependencies [702bc16]
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
  - @typed-sql/compiler@2.3.0-rc.0
  - @typed-sql/core@2.3.0-rc.0
  - @typed-sql/schema@2.3.0-rc.0
  - @typed-sql/config@2.3.0-rc.0

## 2.2.0

This release promotes the changes documented in 2.2.0-rc.0 to stable.

### Patch Changes

- @typed-sql/compiler@2.2.0
  - @typed-sql/config@2.2.0
  - @typed-sql/core@2.2.0
  - @typed-sql/schema@2.2.0

## 2.2.0-rc.0

### Minor Changes

- 5c491f2: Add explicit application, dependency installation, and installed-server verification to the setup planner. Preserve existing ranges, scripts, and editor JSONC comments; reject stale plans and unsafe paths; journal file application for interrupted recovery. Report configuration, installation, and server readiness separately from editor-host verification.
- 20eb300: Add a nonexecuting init planning command with explicit grammar/package selection, package-manager conflict detection, deterministic file proposals, and separately identified installation and editor prerequisites.

### Patch Changes

- 456fa7f: Stage serialized artifacts in sibling files before atomic replacement, preserving existing file permissions and cleaning staging files on failure. Schema generation publishes its self-contained JSON input last. Individual files are atomic; publication across files is not a filesystem transaction.
- 38ea32b: Derive the init plan's missing TypeScript dependency from the compiler's exact supported version policy, preserving existing dependency choices.
- Updated dependencies [b752fde]
- Updated dependencies [456fa7f]
- Updated dependencies [8e6b443]
- Updated dependencies [5387b5e]
- Updated dependencies [7e94958]
- Updated dependencies [a4c4e73]
- Updated dependencies [5c491f2]
- Updated dependencies [2f5f6be]
- Updated dependencies [71a169f]
- Updated dependencies [d176673]
  - @typed-sql/compiler@2.2.0-rc.0
  - @typed-sql/core@2.2.0-rc.0
  - @typed-sql/schema@2.2.0-rc.0
  - @typed-sql/config@2.2.0-rc.0

## 2.1.0

### Minor Changes

- 1041bfa: Add structured opt-in debug events and confirmed support-bundle generation with privacy-safe default redaction.
- 1041bfa: Reject unsupported TypeScript compiler and preview patches before project work begins. Add
  `typed-sql doctor` with human and JSON reports for Node.js, TypeScript, grammar, schema, redacted
  server evidence, language-server/bridge metadata, and editor protocol compatibility.
- 1041bfa: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

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
- Updated dependencies [1041bfa]
- Updated dependencies [1041bfa]
  - @typed-sql/core@2.1.0
  - @typed-sql/compiler@2.1.0
  - @typed-sql/config@2.1.0
  - @typed-sql/schema@2.1.0

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 65b662f: Add structured opt-in debug events and confirmed support-bundle generation with privacy-safe default redaction.
- 4a12de5: Reject unsupported TypeScript compiler and preview patches before project work begins. Add
  `typed-sql doctor` with human and JSON reports for Node.js, TypeScript, grammar, schema, redacted
  server evidence, language-server/bridge metadata, and editor protocol compatibility.
- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.

### Patch Changes

- Updated dependencies [58bd4d1]
- Updated dependencies [58aa9ef]
- Updated dependencies [f902a97]
- Updated dependencies [65b662f]
- Updated dependencies [e433feb]
- Updated dependencies [0efc90c]
- Updated dependencies [ff0e3bb]
- Updated dependencies [6f5b977]
- Updated dependencies [1c64475]
- Updated dependencies [1c64475]
- Updated dependencies [1c64475]
- Updated dependencies [5d5d849]
- Updated dependencies [4a12de5]
- Updated dependencies [1c64475]
  - @typed-sql/core@2.1.0-rc.0
  - @typed-sql/compiler@2.1.0-rc.0
  - @typed-sql/config@2.1.0-rc.0
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
- b4f1b6e: Add deterministic migration compatibility analysis across before/after schema snapshots and query
  manifests. Reports classify both rolling-deployment directions, retain exact source and dependency
  evidence, fail closed for unknown semantics, redact defaults and paths, and support configurable CI
  severity through `typed-sql compat`.
- b2ec119: Add opt-in, grammar-neutral query-plan governance with PostgreSQL and MySQL structured EXPLAIN
  adapters, transient application-owned samples, redacted fingerprint-keyed artifacts, absolute and
  comparable regression budgets, explicit uncertainty, CLI capture and review, documentation, and
  performance coverage.

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
  - @typed-sql/schema@2.0.0
  - @typed-sql/config@2.0.0

## 2.0.0-rc.1

### Patch Changes

- Updated dependencies [9c72dab]
  - @typed-sql/compiler@2.0.0-rc.1

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
  - @typed-sql/compiler@2.0.0-rc.0
  - @typed-sql/schema@2.0.0-rc.0
  - @typed-sql/config@2.0.0-rc.0

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
- 90bae18: Show help and version information without requiring a project configuration, and reject unknown commands before config discovery.
- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- Updated dependencies [eb16de7]
- Updated dependencies [b6389e4]
- Updated dependencies [eb16de7]
- Updated dependencies [b6389e4]
- Updated dependencies [eb16de7]
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [7ca256b]
- Updated dependencies [16e2475]
- Updated dependencies [bd26d6e]
- Updated dependencies [69c7d87]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0
  - @typed-sql/schema@1.0.0
  - @typed-sql/config@1.0.0
  - @typed-sql/compiler@1.0.0

## 1.0.0-rc.0

### Patch Changes

- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- Updated dependencies [69c7d87]
  - @typed-sql/core@1.0.0-rc.0
  - @typed-sql/compiler@1.0.0-rc.0
  - @typed-sql/config@1.0.0-rc.0

## 1.0.0-beta.3

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [bd26d6e]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0-beta.2
  - @typed-sql/schema@1.0.0-beta.2
  - @typed-sql/config@1.0.0-beta.2
  - @typed-sql/compiler@1.0.0-beta.2

## 1.0.0-beta.2

### Patch Changes

- 90bae18: Show help and version information without requiring a project configuration, and reject unknown commands before config discovery.

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- Updated dependencies [16e2475]
  - @typed-sql/core@1.0.0-beta.1
  - @typed-sql/schema@1.0.0-beta.1
  - @typed-sql/config@1.0.0-beta.1
  - @typed-sql/compiler@1.0.0-beta.1

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Patch Changes

- Updated dependencies
  - @typed-sql/compiler@1.0.0-beta.0
  - @typed-sql/config@1.0.0-beta.0
  - @typed-sql/core@1.0.0-beta.0
  - @typed-sql/schema@1.0.0-beta.0
