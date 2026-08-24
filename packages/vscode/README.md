# typed-sql for VS Code (experimental)

This extension bridges typed-sql's generated schema and query resolver to TypeScript 7's native
language server. Hover over a static `sql` template or its directly assigned variable to see the
inferred `Query<{ ... }>` type. SQL diagnostics are published inline without modifying source.

The extension first computes the row through `@typed-sql/ts-bridge`. When the TypeScript 7
extension exposes `initializeAPIConnection`, it sends the typed overlay through
`typescript/unstable/async`, asks the native checker for the tagged-template type, and reports that
authoritative result. If the preview connection is unavailable, hover falls back to the same
resolver used by `typed-sql check`.

The extension discovers `typed-sql.config.ts` and loads the project's installed grammar. Optional
overrides are relative to each workspace folder:

```json
{
  "typedSql.configPath": "typed-sql.config.ts",
  "typedSql.schemaPath": "src/generated/db/schema.json"
}
```

Leave both values empty to use config discovery and `schema.file`. Development setup:

1. Run `pnpm build` from the repository root.
2. Install or enable Microsoft's TypeScript 7 extension.
3. Open this repository in VS Code and launch the `typed-sql extension` configuration.
4. Open `e2e/postgres/src/query.ts` and hover `query` or the SQL template.

Run **typed-sql: Show TypeScript Bridge Status** to see whether the native preview connection or
the resolver fallback is active.
