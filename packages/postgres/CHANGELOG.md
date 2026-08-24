# @typed-sql/postgres

## 1.0.0

### Major Changes

- Release the stable typed-sql 1.0 contract: grammar-agnostic compilation, versioned schema snapshots,
  PostgreSQL and MySQL grammars, application-owned driver adapters, TypeScript 7 inference, editor
  tooling, stable diagnostics, bounded parsing, and real-database/tarball verification.
- Export `sql` and the default `typePolicy` from `@typed-sql/postgres`; generated modules now contain
  schema metadata only. The application imports the optional runtime driver from
  `@typed-sql/postgres/pg` and installs `pg` itself.

### Patch Changes

- Updated dependencies
  - @typed-sql/ast@1.0.0
  - @typed-sql/core@1.0.0
  - @typed-sql/schema@1.0.0
