# @typed-sql/duckdb

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
