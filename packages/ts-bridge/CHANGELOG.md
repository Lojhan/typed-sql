# @typed-sql/ts-bridge

## 2.0.0-rc.1

### Patch Changes

- Updated dependencies [9c72dab]
  - @typed-sql/compiler@2.0.0-rc.1

## 2.0.0-rc.0

### Patch Changes

- 06d1e61: Expose a protocol status request, suppress diagnostics from superseded document versions, and verify
  the shared editor soundness contract across PostgreSQL, MySQL, and SQLite. The VS Code integration now
  uses this standalone server instead of maintaining a second analyzer and preview bridge. Static SQL
  navigation now fails closed inside runtime interpolation expressions.
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

## 1.0.0-rc.0

### Patch Changes

- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- Updated dependencies [69c7d87]
  - @typed-sql/core@1.0.0-rc.0
  - @typed-sql/compiler@1.0.0-rc.0

## 1.0.0-beta.2

### Patch Changes

- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
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
- Updated dependencies [bd26d6e]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0-beta.2
  - @typed-sql/schema@1.0.0-beta.2
  - @typed-sql/compiler@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- Updated dependencies [16e2475]
  - @typed-sql/core@1.0.0-beta.1
  - @typed-sql/schema@1.0.0-beta.1
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
  - @typed-sql/core@1.0.0-beta.0
  - @typed-sql/schema@1.0.0-beta.0
