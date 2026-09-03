# @typed-sql/sqlite

## 2.1.0-rc.0

### Minor Changes

- 1c64475: Add the grammar-neutral parser toolkit and move first-party parsing, ASTs, tokenization, and walking into each grammar package. The historical multi-dialect AST parser is isolated as a deprecated typed-sql 2.x compatibility surface for removal in 3.0.
- e433feb: Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
  comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
  literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
  conformance, and runtime limits while preserving ordinary arrays as single bound values.
- 1c64475: Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
  neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
  Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
  verification proofs, and plan artifacts bind to the schema format and canonical hash.
- 1c64475: Add versioned and compile-option-aware SQLite JSON, JSONB, date/time, math, and optional-extension
  catalogs. Support JSON table-valued functions and an explicit application registry that preserves
  scalar, aggregate, and window routine kinds in schema snapshot v2.
- 1c64475: Harden the optional Node SQLite adapter with connection-time SQLite version and compile-option
  evidence, fail-closed generated-snapshot compatibility checks, policy-aligned storage codecs, and
  schema-aware bounded statement-cache invalidation. The adapter's supported Node.js matrix is now
  declared consistently as Node 22.13+, 24, and 26.
- 1c64475: Complete SQLite schema-v2 evidence for rowid aliases, STRICT and `WITHOUT ROWID` tables, generated
  and hidden columns, virtual and shadow tables, checks, indexes, collations, triggers, and attached
  databases. Preserve SQLite's primary-key nullability rules and use rowid evidence during query and
  write analysis.
- 1c64475: Graduate the SQLite grammar and optional `node:sqlite` adapter to the stable release track. The
  stable contract covers SQLite 3.39.0 through 3.53.4, keeps unknown newer libraries conservative,
  and verifies the adapter on Node 22.13+, 24, and 26 while leaving the driver-neutral grammar usable
  on typed-sql's general Node.js range.
- 1c64475: Resolve SQLite core built-ins, operators, coercions, arities, nullability, and in-band function
  release boundaries from SQLite-owned catalog data. Add a stable diagnostic for invalid SQLite
  built-in invocations and fail closed when version-gated functions lack usable server evidence.

### Patch Changes

- 1c64475: Add deterministic versioned dialect capability states backed by normalized server versions,
  settings, extensions, and compile options. Query manifests now invalidate on capability changes and
  record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
  report. The boolean capability map remains available as an additive migration bridge.
- Updated dependencies [58bd4d1]
- Updated dependencies [58aa9ef]
- Updated dependencies [1c64475]
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
  - @typed-sql/ast@2.1.0-rc.0
  - @typed-sql/schema@2.1.0-rc.0

## 2.0.0

### Major Changes

- Graduate the SQLite grammar and optional `node:sqlite` adapter to the stable release track with a
  documented SQLite 3.39.0–3.53.4 language baseline, fail-closed version and compile-option gates,
  snapshot v2 evidence, and runtime compatibility checks.

## 2.0.0-rc.2

### Patch Changes

- Align the experimental SQLite package with the stable 2.0.0 core, AST, and schema packages so npm
  consumers retain one coherent set of branded query and fragment types.

## 2.0.0-rc.1

### Patch Changes

- Publish the coherent 2.0.0-rc.1 release-candidate train.

## 2.0.0-rc.0

### Minor Changes

- af27a0e: Add the experimental SQLite grammar with sound flexible-table storage unions, precise STRICT-table
  types, catalog snapshots for views, generated columns, indexes, foreign keys, and attached schemas,
  compound-query and RETURNING inference, and an optional application-owned `node:sqlite` adapter for
  prepared execution, nested transactions, ordered batches, and typed streams.
- e654fae: Add opt-in Standard Schema V1 result validation with compile-time output compatibility, immutable
  query attachment, sync and async validators, redacted fingerprinted errors, and consistent decoded-row
  handling across buffered cardinality methods, batches, PostgreSQL pipelines, streams, and transactions.

### Patch Changes

- 7023011: Support Node.js 22.11 and 22.12 by normalizing file URLs before opening `DatabaseSync` and using a
  buffered iterator when those Node releases do not yet provide `StatementSync.iterate()`.
- Updated dependencies [29afc3d]
- Updated dependencies [3f063f6]
- Updated dependencies [6a7ae58]
- Updated dependencies [af27a0e]
- Updated dependencies [b06fd0a]
- Updated dependencies [3050209]
- Updated dependencies [1b054b6]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/ast@2.0.0-rc.0
  - @typed-sql/core@2.0.0-rc.0
  - @typed-sql/schema@2.0.0-rc.0

## 1.0.0-rc.0

### Minor Changes

- Add the preview SQLite grammar, sound flexible-table typing, catalog introspection, and optional
  application-owned `node:sqlite` adapter.
