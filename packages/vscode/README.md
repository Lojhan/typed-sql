# typed-sql for VS Code (experimental)

The VS Code extension loads each workspace folder's installed grammar and generated schema. Hover
over a static `sql` template or any downstream value to see the inferred query type; SQL and
TypeScript parameter diagnostics, completion, definitions, and safe quick fixes stay inline without
rewriting source files.

The extension asks Microsoft's TypeScript 7 preview connection to verify the in-memory overlay. If
that connection is unavailable or its preview API changes, SQL analysis remains available through a
clearly labeled resolver fallback. Run **typed-sql: Show TypeScript Bridge Status** to see which path
is active.

## Install the current experimental build

Until the extension has a Marketplace release, build its VSIX from a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/vscode package:vsix
code --install-extension artifacts/typed-sql-vscode.vsix
```

In the application, install the selected grammar and generate its schema normally. Configuration is
optional and scoped independently to each workspace folder:

```json
{
  "typedSql.configPath": "typed-sql.config.ts",
  "typedSql.schemaPath": "src/generated/db/schema.json",
  "typedSql.nativePreview": true
}
```

Leave the path values empty to discover `typed-sql.config.ts` and use its `schema.file`. Opening,
editing, saving, regenerating a schema, changing settings, or restarting VS Code invalidates the
bounded analysis caches. Errors are written to the **typed-sql** output channel with the affected
file and cause.

## Develop this repository

Run `pnpm build`, install or enable Microsoft's TypeScript 7 extension, and launch the
`typed-sql extension` debug configuration. Open `e2e/postgres/src/query.ts` and hover `query`,
`rows`, or `Actual`.
