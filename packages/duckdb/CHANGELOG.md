# @typed-sql/duckdb

## 3.0.0-rc.0

### Major Changes

- 63e76b2: Make grammar roots lightweight entrypoints for application SQL, runtime plans, rendering and type
  policy. Keep profile construction on explicit `/profile` entrypoints. Move eager analyzer factories
  and the previous full root export surfaces to explicit `/analysis` compatibility entrypoints. Application `sql` imports stay at the
  selected grammar root. Migrate analyzer, introspection and semantic routing imports to `/analysis`,
  or register an explicit lazy analyzer loader alongside a lightweight profile for development hosts.
  
  Scaffold new projects with a lightweight profile and a separate lazy analyzer contribution.

### Minor Changes

- 63e76b2: Add explicit DuckDB native query-contract acquisition and reconciliation for builtin expression queries on qualified Node SDK engines. Prepared logical types preserve decimal dimensions and nested shapes without binding or executing application SQL. Unavailable parameter metadata remains unavailable, and nullability remains conservative. Distinguish unsupported offline routine result metadata with TSQ408 so qualified native evidence can supply that facet while invalid SQL diagnostics remain blocking.
- 63e76b2: Add bounded, version-specific offline core analyzers and explicit compatibility packs. The core
  retains complete selected overload families, operators, native type combinations and codecs;
  omitted functions produce an actionable diagnostic and can use qualified native query contracts.
  A matching compatibility pack restores the engine's full existing offline rules. Existing analyzer
  imports retain their supported behavior. Core imports load neither full catalogs nor native SDKs.
- 63e76b2: Add explicit offline analyzer entrypoints for each qualified DuckDB engine. They retain the
  selected engine's existing semantics and reject mismatched snapshots while excluding other
  engine catalogs from the import graph. The existing analyzer continues to support both engines.
  
  An unresolved generic MAP result now produces conservative analysis instead of dereferencing
  missing child type metadata.
- 63e76b2: Expose explicit driver-free `/profile` entrypoints for contract consumers without loading semantic
  catalogs, resolvers or introspection providers. Existing analyzer factories share the same profile
  mechanics, including parameter extraction, snapshot validation, rendering and type policy. DuckDB
  retains contextual parser-based parameter extraction.

### Patch Changes

- 63e76b2: Use grammar-owned ASCII case rules in DuckDB and SQLite. Unicode spellings that JavaScript folds into ASCII no longer resolve optimistically to builtins, SQL keywords or type aliases. Allow schema indexes to receive a comparison policy and cache indexes separately by policy.
- 63e76b2: Describe guarded stored-table SELECT queries through native contracts, including projections,
  stars, filters and joins. Bind context to live relation/column definitions and reject generated
  columns and unsafe relation bindings before candidate preparation. Reject user macro overlaps in
  implicit operator, constructor and extraction bindings as well as explicit calls. Update the acquisition identity
  so earlier artifacts require regeneration.
- 63e76b2: Recognize DEC, GUID, INTEGRAL, NVARCHAR, OID and TIMESTAMP_US using their native canonical types on both supported engines. Native contract and reconciliation identities advance; regenerate captured DuckDB contracts after upgrading.
- 63e76b2: Keep execution adapter imports independent of schema discovery and semantic catalogs. Share cold
  provider and extension contracts, preserve server/session evidence checks in dedicated modules, and
  load introspection implementations only when requested. PostgreSQL extension-manifest validation
  retains its explicit opt-in semantic resolution path and existing error identity.
- 63e76b2: Report an unsupported result when nullable DuckDB 1.5 table-function arguments can change the native output type. NULL and non-NULL parameter bindings can produce different schemas even when the SQL casts are identical.
- 63e76b2: Keep active query views valid when live database observations confirm an unchanged context. Observation timestamps still refresh, while catalog changes, retirement and invalidation retain their publication fences. This avoids spurious unavailable editor diagnostics when context refresh overlaps query preparation.
  
  Require consistent builtin scalar families for DuckDB native expression acquisition. Session-dependent binding results require separate qualification. Advance the adapter/profile revision so previously captured contracts cannot bypass this admission change.
- 63e76b2: Apply source-owned keyword and name permissions for each qualified engine. Preserve overlapping column/function/type classes, version-specific bare aliases and special function heads. Distinguish constructor syntax from column references and keep Unicode lookalikes separate from ASCII built-ins. Retire query contracts from preceding interpretation rules.
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
  - @typed-sql/analysis@3.0.0-rc.0
  - @typed-sql/core@3.0.0-rc.0
  - @typed-sql/schema@3.0.0-rc.0

## 2.5.0

Promote the qualified `2.5.0-rc.0` candidate to stable. See that entry below for the included features and fixes.

### Patch Changes

- @typed-sql/ast@2.5.0
  - @typed-sql/core@2.5.0
  - @typed-sql/schema@2.5.0

## 2.5.0-rc.0

### Minor Changes

- 1e7c465: Add a DuckDB grammar with catalog-backed snapshots, native nested-value policies, compiled query contracts and explicit engine qualification.
  
  Include explicit application-owned Node SDK execution, atomic native vector appends, non-executing verification and structured plan capture, versioned native coercion catalogs, and browser-safe analysis. Qualify DuckDB 1.5.6 and 2.0.0 with their matching SDK releases.

### Patch Changes

- 1e7c465: Apply query cancellation and deadlines to session attestation and preparation before execution, retain late native stream results for cleanup, and quarantine connections whose interruption fails.
- Updated dependencies [1b90678]
- Updated dependencies [81c8c46]
- Updated dependencies [0147b7a]
- Updated dependencies [a0c17a6]
  - @typed-sql/core@2.5.0-rc.0
  - @typed-sql/schema@2.5.0-rc.0
