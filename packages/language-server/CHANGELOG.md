# @typed-sql/language-server

## 2.1.0

### Patch Changes

- 9e74474: Validate the bundled TypeScript preview entrypoint before proxy initialization so a missing or corrupted installation reports the actionable recovery diagnostic instead of an `EPIPE` process failure.
- 01d03f0: Return project-unavailable diagnostics through pull requests while schema analysis is unavailable, and clear the previously pushed failure after recovery. Preserve current TypeScript and SQL diagnostics by refreshing the combined pull report.
- 5387b5e: Refresh changed local configuration dependencies and recognize their editor file-watch events, while reusing unchanged evaluated configurations.
- 9213ae6: Map cross-document TypeScript locations and workspace edits using their target document, and preserve opaque LSP resolution data.
- 7f1b753: Translate versioned workspace edits between generated and original documents, rejecting stale source snapshots instead of forwarding mismatched version numbers.
- 14b7e12: Preserve upstream TypeScript LSP completion resolution, trigger characters and code-action options while adding SQL capabilities.
- fbdf473: Retain source snapshot identity through upstream completion, code action, inlay hint and code lens resolution. Preserve upstream opaque data and reject expired or stale resolve requests instead of mapping edits without an owning document.
- 8ff93f6: Project TypeScript semantic highlighting onto original source and produce bounded source-coordinate delta responses without exposing generated annotation tokens.
- 90e4ace: Keep combined TypeScript and SQL diagnostics visible in pull-diagnostic clients such as VS Code. Overlay refresh requests a fresh pull instead of overwriting the report with a SQL-only push; push-only clients retain their existing delivery path.
- 6c736a6: Keep diagnostic pulls recoverable when schema analysis fails during a request, and request a retry for stale diagnostic snapshots instead of allowing an empty report to replace current errors.
- Updated dependencies [b752fde]
- Updated dependencies [456fa7f]
- Updated dependencies [8e6b443]
- Updated dependencies [5387b5e]
- Updated dependencies [7e94958]
- Updated dependencies [2f5f6be]
- Updated dependencies [71a169f]
- Updated dependencies [d176673]
  - @typed-sql/core@2.2.0
  - @typed-sql/schema@2.2.0
  - @typed-sql/config@2.1.1
  - @typed-sql/ts-bridge@2.1.0

## 2.1.0-rc.1

### Patch Changes

- Publish the coherent 2.1.0-rc.1 release-candidate train.

## 2.1.0-rc.0

### Minor Changes

- 25e13cc: Negotiate typed-sql protocol capabilities during LSP initialization and attach complete analysis
  identities to diagnostics. Invalidate results by source, project/config generation, grammar
  capabilities, schema, and type-policy identity before publishing or applying fixes.
- d1d674c: Cancel superseded incremental analysis without losing document state, serialize workspace refreshes,
  publish redacted recoverable project failures, restart failed native inspection once, and expose
  bounded-cache and bridge-restart metrics through the status request.
- 5d5d849: Add deterministic conformance failure injection and expose the bounded config and language-server cache defaults used by reliability suites.
- 8cd54dd: Publish immutable support policies for the exact TypeScript compiler and preview-backend patches,
  new-line canary admission, and the typed-sql-specific language-server protocol compatibility window.

### Patch Changes

- 58bd4d1: Add the versioned, serializable source-analysis service shared by batch checks and editor tooling.
  Results carry deterministic source, project, schema, type-policy, grammar, and capability identities;
  cancellation and source, query-count, structural-variant, and generated-declaration limits fail closed.
- 946e195: Add an explicit TypeScript backend contract with immutable backend identities, opaque project
  handles, overlay inspection, deterministic project disposal, and an exact TypeScript 7.1 adapter.
  Contain all unstable TypeScript API imports inside the version-specific adapter while retaining the
  native preview bridge as a compatibility wrapper.
- 4a12de5: Reject unsupported TypeScript compiler and preview patches before project work begins. Add
  `typed-sql doctor` with human and JSON reports for Node.js, TypeScript, grammar, schema, redacted
  server evidence, language-server/bridge metadata, and editor protocol compatibility.
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
- Updated dependencies [946e195]
- Updated dependencies [8cd54dd]
- Updated dependencies [4a12de5]
- Updated dependencies [1c64475]
  - @typed-sql/core@2.1.0-rc.0
  - @typed-sql/ts-bridge@2.1.0-rc.0
  - @typed-sql/config@2.1.0-rc.0
  - @typed-sql/schema@2.1.0-rc.0

## 2.0.0-rc.2

### Patch Changes

- Align the experimental language server with the stable 2.0.0 packages and the compatible
  `@typed-sql/ts-bridge@2.0.0-rc.2` companion.

## 2.0.0-rc.1

### Patch Changes

- @typed-sql/ts-bridge@2.0.0-rc.1

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
- Updated dependencies [06d1e61]
- Updated dependencies [b4f1b6e]
- Updated dependencies [87189c3]
- Updated dependencies [e654fae]
- Updated dependencies [b2ec119]
  - @typed-sql/core@2.0.0-rc.0
  - @typed-sql/schema@2.0.0-rc.0
  - @typed-sql/ts-bridge@2.0.0-rc.0
  - @typed-sql/config@2.0.0-rc.0

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
