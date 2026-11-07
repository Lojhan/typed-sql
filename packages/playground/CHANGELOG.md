# @typed-sql/playground

## 2.6.0-rc.0

### Minor Changes

- 825eba3: Connect the trusted local workspace to an optional project-installed language server for TypeScript and SQL diagnostics, hover, completion, definitions, and reviewed quick fixes. Standalone SQL uses grammar analysis with original source positions. Definition documents remain bounded and read-only, and unsaved overlays never overwrite repository files.
  
  JavaScript and JSX use the project’s native JavaScript checking settings. Complete dirty working-copy contexts keep imported helpers current across editor tabs.
- 825eba3: Add an optional local dev workspace with captured schema relationships, real project file editing, inferred SQL contracts, and checked TypeScript/SQL execution through explicit lazy targets. Include an application-owned PostgreSQL adapter with bounded cursor results, cancellation and read-only execution, plus loopback session protection and lossless result export. Keep query files in a repository folder across sessions, reuse the docs playground file tree and resizable split-editor interactions, page cursor results on demand without a fixed row cutoff, compare captured runs, and connect explicitly configured local ACP agents with private user configuration and reviewed repository-file proposals.
  
  Provide a headerless workspace with a command palette, editor search, layout shortcuts and theme controls. Format editor buffers through repository-configured, locally installed Biome or Prettier without automatically saving files or installing tools.
  
  Connect an optional local language-server companion for hover, completions, definitions, quick fixes and inline diagnostics with full unsaved working-copy context. Preserve TypeScript runtime import resolution across JS/TS source families and bind sanitized PostgreSQL diagnostics to proven captured SQL spans.
- 825eba3: Explore schemas, tables, columns, enums, indexes and relationships alongside repository files. Inspect structured object details and recorded migration changes in splittable tabs, open table details by double-clicking the schema board, and browse applied, pending and interrupted migration history without running migrations from the workspace.

### Patch Changes

- 825eba3: Expose optional, per-turn MCP workspace tools to configured local ACP agents. Tools inspect captured schema, migrations, files and results; analyze SQL; execute bounded database-enforced read-only queries; and propose file changes for explicit review. Capabilities expire with the turn and require trusted execution plus explicit tool sharing.
- 825eba3: Preserve editor revisions and current diagnostics across renames and schema refreshes, prevent project runs from silently using unsaved dependencies, and improve keyboard menus and interrupted resize cleanup. Preserve completed agent outcomes during shutdown.
- 825eba3: Standardize workspace section bars, square icon buttons, text controls, fields, tree rows, tabs, menus and panels with shared components and sizing tokens. Keep keyboard interactions and responsive layouts consistent across schema, query, result, comparison and agent views.
  
  Use the same tab bar, separators, hover surface and top selection indicator for workspace files, query tools and object inspection. Section tabs omit the optional close action.
- Updated dependencies [4de04fc]
- Updated dependencies [825eba3]
- Updated dependencies [825eba3]
- Updated dependencies [825eba3]
  - @typed-sql/migrations@2.6.0-rc.0
  - @typed-sql/postgres@2.6.0-rc.0
  - @typed-sql/core@2.6.0-rc.0
  - @typed-sql/compiler@2.6.0-rc.0
  - @typed-sql/build@2.6.0-rc.0
  - @typed-sql/config@2.6.0-rc.0
  - @typed-sql/schema@2.6.0-rc.0
