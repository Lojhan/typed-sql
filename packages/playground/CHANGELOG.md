# @typed-sql/playground

## 3.0.0-rc.0

### Minor Changes

- 5c7a9f0: Render local agent Markdown and structured tool results, and add interactive query-backed analysis cards with charts, exact metrics, linked filters, data inspection, exports and persisted workspace tabs. Agents publish validated presentation specifications over scoped MCP tools; database execution remains checked and read only. Save reusable `.analysis.json` definitions in project roots without including captured rows. Tool permissions support asking before use, allowing a conversation, or disabling tools. Collapse per-turn activity and group secondary toolbar actions into responsive overflow menus across the workspace.
- 825eba3: Connect the trusted local workspace to an optional project-installed language server for TypeScript and SQL diagnostics, hover, completion, definitions, and reviewed quick fixes. Standalone SQL uses grammar analysis with original source positions. Definition documents remain bounded and read-only, and unsaved overlays never overwrite repository files.
  
  JavaScript and JSX use the project’s native JavaScript checking settings. Complete dirty working-copy contexts keep imported helpers current across editor tabs.
- 825eba3: Add an optional local dev workspace with captured schema relationships, real project file editing, inferred SQL contracts, and checked TypeScript/SQL execution through explicit lazy targets. Include an application-owned PostgreSQL adapter with bounded cursor results, cancellation and read-only execution, plus loopback session protection and lossless result export. Keep query files in a repository folder across sessions, reuse the docs playground file tree and resizable split-editor interactions, page cursor results on demand without a fixed row cutoff, compare captured runs, and connect explicitly configured local ACP agents with private user configuration and reviewed repository-file proposals.
  
  Provide a headerless workspace with a command palette, editor search, layout shortcuts and theme controls. Format editor buffers through repository-configured, locally installed Biome or Prettier without automatically saving files or installing tools.
  
  Connect an optional local language-server companion for hover, completions, definitions, quick fixes and inline diagnostics with full unsaved working-copy context. Preserve TypeScript runtime import resolution across JS/TS source families and bind sanitized PostgreSQL diagnostics to proven captured SQL spans.
- 76d4cf0: Use configured offline, frozen and trusted live analysis in workspace previews, SQL tools and captured runs. Share document preparation with the editor, preserve enriched catalog schemas, and keep execution workers from initializing analyzers or native qualification adapters. PostgreSQL selected-catalog capture requests text-array namespace metadata so ordinary pg clients need no name-array parser override.
- 825eba3: Explore schemas, tables, columns, enums, indexes and relationships alongside repository files. Inspect structured object details and recorded migration changes in splittable tabs, open table details by double-clicking the schema board, and browse applied, pending and interrupted migration history without running migrations from the workspace.

### Patch Changes

- 3753571: Center overflow toolbar icons and align their triggers with neighboring controls. Keep text alignment rules scoped to menu contents. Move agent, permission and context settings into contextual panes below the chat prompt, with an icon send action and dismissible agent configuration. Add a left-edge mobile project drawer and persistent resizing between Files, Database and Migrations.
- 825eba3: Expose optional, per-turn MCP workspace tools to configured local ACP agents. Tools inspect captured schema, migrations, files and results; analyze SQL; execute bounded database-enforced read-only queries; and propose file changes for explicit review. Capabilities expire with the turn and require trusted execution plus explicit tool sharing.
- 825eba3: Preserve editor revisions and current diagnostics across renames and schema refreshes, prevent project runs from silently using unsaved dependencies, and improve keyboard menus and interrupted resize cleanup. Preserve completed agent outcomes during shutdown.
- 825eba3: Standardize workspace section bars, square icon buttons, text controls, fields, tree rows, tabs, menus and panels with shared components and sizing tokens. Keep keyboard interactions and responsive layouts consistent across schema, query, result, comparison and agent views.
  
  Use the same tab bar, separators, hover surface and top selection indicator for workspace files, query tools and object inspection. Section tabs omit the optional close action.
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
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [76d4cf0]
  - @typed-sql/analysis@3.0.0-rc.0
  - @typed-sql/core@3.0.0-rc.0
  - @typed-sql/migrations@3.0.0-rc.0
  - @typed-sql/postgres@3.0.0-rc.0
  - @typed-sql/build@3.0.0-rc.0
  - @typed-sql/config@3.0.0-rc.0
  - @typed-sql/compiler@3.0.0-rc.0
  - @typed-sql/schema@3.0.0-rc.0
