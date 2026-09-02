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

The existing typed-sql-specific request and initialization shape is protocol v1. Unversioned clients
are treated as v1, and `TYPED_SQL_PROTOCOL_SUPPORT_POLICY` publishes the accepted compatibility
window. Removing an accepted protocol version requires a language-server major release.

Startup validates the bundled TypeScript preview patch before spawning it. Run `typed-sql doctor`
from the workspace for a redacted compatibility report when the server or an editor client cannot
start.

Use typed-sql as the sole TypeScript language server for a configured project. A second server sees
the conservative package declaration and may display a competing `Query<unknown>` hover.

Read [Editor setup](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md),
[Compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/compatibility.md), and
the [Zed extension guide](https://github.com/Lojhan/typed-sql/blob/main/editors/zed/README.md).

MIT © typed-sql contributors
