# @typed-sql/language-server

> Experimental: this package depends on the preview-backed TypeScript bridge.

The grammar-neutral typed-sql language server provides TypeScript semantics plus inferred SQL
hovers, downstream value types, diagnostics, completion, definitions, quick fixes, cancellation,
stale-result suppression, bounded workspace caches, and a protocol status request.

```sh
pnpm add -D @typed-sql/language-server
pnpm exec typed-sql-language-server --stdio
```

The server discovers `typed-sql.config.ts`, loads the application's grammar and generated schema,
applies the query overlay in memory, and proxies its isolated TypeScript preview. It does not load a
workspace `tsserver.js`, and source files are never rewritten.

Initialization settings include `configPath`, `schemaPath`, `projectFile`, `nativePreview`,
`maxCacheEntries`, and `maxWorkspaceFiles`. Relative paths resolve from the LSP workspace root;
each workspace folder receives an independent config, grammar, schema, project, and bounded cache.

Clients can request `typedSql/status` to inspect the exact pinned TypeScript preview version,
workspace roots, and open/indexed document counts. The server suppresses diagnostics from document
versions that have already been superseded.

Use typed-sql as the sole TypeScript language server for a configured project. A second server sees
the conservative package declaration and may display a competing `Query<unknown>` hover.

Read [Editor setup](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md),
[Compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/compatibility.md), and
the [Zed extension guide](https://github.com/Lojhan/typed-sql/blob/main/editors/zed/README.md).

MIT © typed-sql contributors
