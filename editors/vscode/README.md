# typed-sql for VS Code

> Experimental: the extension distribution and preview TypeScript integration may change.

The VS Code extension is a thin client for each workspace folder's installed
`@typed-sql/language-server`. PostgreSQL, MySQL, and SQLite therefore use the same analysis,
diagnostics, completion, definition, quick-fix, cache, and TypeScript preview path in VS Code, Zed,
and other LSP clients.

Install the server in the application before installing the extension:

```sh
pnpm add -D @typed-sql/language-server
```

Build the current VSIX from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./editors/vscode package:vsix
code --install-extension artifacts/typed-sql-vscode.vsix
```

Configuration is optional and scoped per workspace folder:

```json
{
  "typedSql.configPath": "typed-sql.config.ts",
  "typedSql.schemaPath": "src/generated/db/schema.json",
  "typedSql.projectFile": "tsconfig.json",
  "typedSql.nativePreview": true
}
```

Leave path values empty to discover the config, its `schema.file`, and configured projects. Each
workspace folder receives its own language-server process and settings. `typedSql.serverPath` can
override the workspace-installed server for development.

Use typed-sql as the workspace's sole TypeScript language server. Disable VS Code's built-in
TypeScript language-features extension for that workspace so its conservative `Query<unknown>`
hover does not compete with the transformed program. Run **typed-sql: Show TypeScript Bridge
Status** to see the exact pinned TypeScript version, negotiated protocol, and document counts
reported by every server. The extension negotiates protocol v1 and its identity, fix, and status
capabilities at startup.

Read the [editor setup guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md).

MIT © typed-sql contributors
