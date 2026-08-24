# @typed-sql/language-server

A grammar-neutral TypeScript 7 language server for [typed-sql](https://github.com/Lojhan/typed-sql).
It provides complete TypeScript semantics plus exact SQL hovers, downstream value types, diagnostics,
completion, definitions, safe quick fixes, cancellation, and bounded workspace caches.

```sh
pnpm add -D @typed-sql/language-server@next
pnpm exec typed-sql-language-server --stdio
```

The server discovers `typed-sql.config.ts`, loads the project's installed dialect, analyzes static
queries against the generated schema, applies the inferred type overlay in memory, and proxies the
native TypeScript 7.1 preview semantic program. Source files are never rewritten.

Initialization options and `workspace/didChangeConfiguration` accept:

```json
{
  "configPath": "typed-sql.config.ts",
  "schemaPath": "generated/db/schema.json",
  "projectFile": "tsconfig.json",
  "nativePreview": true,
  "maxCacheEntries": 256,
  "maxWorkspaceFiles": 2000
}
```

`configPath` is optional and discovered upward from the workspace. `schemaPath` and `projectFile`
are overrides; relative paths resolve from the LSP workspace root.

## Zed

Use typed-sql as the sole TypeScript and TSX server:

```json
{
  "languages": {
    "TypeScript": {
      "language_servers": ["typed-sql", "!vtsls", "!typescript-language-server"]
    },
    "TSX": {
      "language_servers": ["typed-sql", "!vtsls", "!typescript-language-server"]
    }
  },
  "lsp": {
    "typed-sql": {
      "binary": {
        "path": "node",
        "arguments": [
          "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js",
          "--stdio"
        ]
      },
      "settings": {
        "configPath": "typed-sql.config.ts",
        "schemaPath": "generated/db/schema.json",
        "projectFile": "tsconfig.json",
        "nativePreview": true
      }
    }
  }
}
```

Do not run `vtsls` or `typescript-language-server` beside this proxy: an untransformed server sees
the package's safe baseline `Query<unknown>` and can display a competing hover.

See the [Zed extension guide](https://github.com/Lojhan/typed-sql/blob/main/editors/zed/README.md).

MIT © typed-sql contributors
