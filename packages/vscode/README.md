# typed-sql for VS Code

> Experimental: the extension distribution and preview TypeScript integration may change.

The VS Code extension loads each workspace folder's installed grammar and generated schema. It
provides inferred SQL hovers, downstream value types, diagnostics, completion, definitions, and
safe quick fixes without rewriting source files.

Build the current VSIX from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/vscode package:vsix
code --install-extension artifacts/typed-sql-vscode.vsix
```

Configuration is optional and scoped per workspace folder:

```json
{
  "typedSql.configPath": "typed-sql.config.ts",
  "typedSql.schemaPath": "src/generated/db/schema.json",
  "typedSql.nativePreview": true
}
```

Leave path values empty to discover the config and its `schema.file`. Run **typed-sql: Show
TypeScript Bridge Status** to inspect the active semantic path.

Read the [editor setup guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md).

MIT © typed-sql contributors
