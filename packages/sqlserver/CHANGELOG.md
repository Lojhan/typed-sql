# @typed-sql/sqlserver

## 3.0.0

### Patch Changes

- @typed-sql/analysis@3.0.0
  - @typed-sql/ast@3.0.0
  - @typed-sql/core@3.0.0
  - @typed-sql/schema@3.0.0

## 3.0.0-rc.0

### Major Changes

- 63e76b2: Make grammar roots lightweight entrypoints for application SQL, runtime plans, rendering and type
  policy. Keep profile construction on explicit `/profile` entrypoints. Move eager analyzer factories
  and the previous full root export surfaces to explicit `/analysis` compatibility entrypoints. Application `sql` imports stay at the
  selected grammar root. Migrate analyzer, introspection and semantic routing imports to `/analysis`,
  or register an explicit lazy analyzer loader alongside a lightweight profile for development hosts.
  
  Scaffold new projects with a lightweight profile and a separate lazy analyzer contribution.

### Minor Changes

- 63e76b2: Expose explicit driver-free `/profile` entrypoints for contract consumers without loading semantic
  catalogs, resolvers or introspection providers. Existing analyzer factories share the same profile
  mechanics, including parameter extraction, snapshot validation, rendering and type policy. DuckDB
  retains contextual parser-based parameter extraction.
- 63e76b2: Add portable offline core analyzer entrypoints that retain maintained rules and request qualified query contracts for unmapped scalar functions. Existing analyzers remain compatible. Native reconciliation accepts the core diagnostic within each adapter's qualified scope and retains conservative metadata bounds.
  
  SQL Server invalid built-in arities now retain supplied argument evidence and return unknown after diagnosis instead of entering a rule that can read missing arguments.
- 63e76b2: Add explicit native query-contract acquisition, compatibility identities and independent reconciliation entrypoints. Application-owned exclusive sessions describe supported builtin expression queries without executing them; ordinary imports and frozen checking do not open native sessions. Incomplete metadata and contradictory static claims remain blocking.

### Patch Changes

- 63e76b2: Keep execution adapter imports independent of schema discovery and semantic catalogs. Share cold
  provider and extension contracts, preserve server/session evidence checks in dedicated modules, and
  load introspection implementations only when requested. PostgreSQL extension-manifest validation
  retains its explicit opt-in semantic resolution path and existing error identity.
- 63e76b2: Describe guarded SELECT projections, stars, filters and joins over schema-qualified ordinary local
  tables during explicit native query-contract generation. Resolve identifiers as bound metadata,
  retain log-quiescence checks, and reject unsupported relation or column capabilities before
  description. Include table and security-predicate metadata in context identity. The updated
  adapter/profile identity requires regeneration of previous native contracts.
- 63e76b2: Bind native query contracts to the original/current login and database-user identities, including SIDs. Missing identity metadata declines acquisition. Regenerate earlier SQL Server native contracts after this adapter identity change.
- 63e76b2: Apply compact, source-derived SQL Server keyword permissions reconciled against native description across all supported engine and compatibility pairs. Preserve quoted keyword identifiers and reject unquoted names in contexts where the selected engine reserves them. Include vocabulary identity in query contract invalidation without loading the parser vocabulary into runtime or frozen consumers.
- 63e76b2: Include explicit database permissions and effective database/server permissions in native query contract context identity. Permission changes invalidate prior context even when the principal and schema stay the same. The native adapter identity changes and previously generated native contracts require regeneration.
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

- 89d17ab: Add an independently owned SQL Server grammar with catalog evidence, explicit type policies and application-owned native execution.

### Patch Changes

- Updated dependencies [1b90678]
- Updated dependencies [81c8c46]
- Updated dependencies [0147b7a]
- Updated dependencies [a0c17a6]
  - @typed-sql/core@2.5.0-rc.0
  - @typed-sql/schema@2.5.0-rc.0
