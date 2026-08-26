# @typed-sql/language-server

## 1.0.0-rc.0

### Patch Changes

- 69c7d87: Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
  language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
  values remain parameterized across the edit.
- Updated dependencies [69c7d87]
  - @typed-sql/core@1.0.0-rc.0
  - @typed-sql/ts-bridge@1.0.0-rc.0
  - @typed-sql/config@1.0.0-rc.0

## 1.0.0-beta.2

### Patch Changes

- 9fb24a7: Make external editor startup reproducible from the installed package. Route multi-root workspaces
  through independent grammar/config/schema services, keep generated schema reloads synchronized with
  the TypeScript overlay, guard preview process failures with actionable errors, and launch the packed
  language-server executable in PostgreSQL and MySQL editor smoke tests.
- 1563a7a: Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
  PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
  language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
  and remove internal compiler/type helpers from stable package-root exports before 1.0.
- bd26d6e: Replace potentially expensive parser regular expressions with bounded scanners, tighten editor
  completion matching, and prevent releases while high-severity CodeQL alerts remain open.
- Updated dependencies [1563a7a]
- Updated dependencies [9dd6bc4]
- Updated dependencies [3e2c75c]
  - @typed-sql/core@1.0.0-beta.2
  - @typed-sql/schema@1.0.0-beta.2
  - @typed-sql/config@1.0.0-beta.2
  - @typed-sql/ts-bridge@1.0.0-beta.2

## 1.0.0-beta.1

### Patch Changes

- 16e2475: Prove npm trusted publishing and provenance after the initial registry bootstrap.
- Updated dependencies [16e2475]
  - @typed-sql/core@1.0.0-beta.1
  - @typed-sql/schema@1.0.0-beta.1
  - @typed-sql/config@1.0.0-beta.1
  - @typed-sql/ts-bridge@1.0.0-beta.1

## 1.0.0-beta.0

### Major Changes

- Release the first public typed-sql beta: exact TypeScript 7 row inference from static PostgreSQL and
  MySQL, versioned schema introspection, application-owned drivers, config-driven grammar plugins,
  CLI verification, editor language-server integration, versioned diagnostics, bounded parsing, and
  real-database plus packed-tarball verification.

### Patch Changes

- Updated dependencies
  - @typed-sql/config@1.0.0-beta.0
  - @typed-sql/core@1.0.0-beta.0
  - @typed-sql/schema@1.0.0-beta.0
  - @typed-sql/ts-bridge@1.0.0-beta.0
