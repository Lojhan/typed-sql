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
workspace roots, open/indexed document counts, and negotiated protocol. The server suppresses
diagnostics unless the source version, source hash, project generation, config hash, grammar and
capability identity, schema identity, and type-policy identity are still current.

The typed-sql-specific request and initialization shape is protocol v1. A versioned client sends
`protocol: { version: 1, capabilities: [...] }` inside its `typedSql` initialization options (the
flat `protocolVersion` and `protocolCapabilities` keys are also accepted). The server returns the
negotiated intersection in `initialize.typedSql.protocol`. Protocol capabilities are
`analysis-identity`, `diagnostic-fixes`, and `status`. Unversioned clients are treated as v1 with all
v1 capabilities, while invalid or unsupported versions fail initialization with an upgrade message.
Removing an accepted protocol version requires a language-server major release.

Startup validates the bundled TypeScript preview patch before spawning it. Run `typed-sql doctor`
from the workspace for a redacted compatibility report when the server or an editor client cannot
start.

Use typed-sql as the sole TypeScript language server for a configured project. A second server sees
the conservative package declaration and may display a competing `Query<unknown>` hover.

Read [Editor setup](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md),
[Compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/compatibility.md), and
the [Zed extension guide](https://github.com/Lojhan/typed-sql/blob/main/editors/zed/README.md).

MIT © typed-sql contributors
