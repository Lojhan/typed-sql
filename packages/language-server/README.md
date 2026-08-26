# @typed-sql/language-server

> **Experimental:** this package depends on the preview-backed TypeScript bridge and remains on the
> npm `next` track when the SQL/compiler packages reach stable 1.0.

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

When a conditional SQL branch uses a bare template beside `sql.empty` or `sql.fragment`, the server
reports `TSQ004` at the nested template and offers a preferred `Mark as sql.fragment` quick fix. The
edit only adds the trusted tag; nested values remain parameterized.

The executable and its pinned preview are self-contained in the project installation. It does not
load the workspace TypeScript package or require `tsserver.js`; a TypeScript 7.0 package without that
legacy file is supported. Failure to start the pinned preview returns an initialization error with
the preview version, underlying cause, and reinstall command instead of leaving the editor hanging.

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

Every entry in LSP `workspaceFolders` gets a separate config, grammar, schema, project, and bounded
cache. Watched typed-sql config/schema changes are reanalyzed before the next request and the updated
overlay is kept open in TypeScript; unrelated watch events continue to the native preview. This is
the contract used by the packed PostgreSQL/MySQL editor smoke test, including restart behavior.

## Zed

Install the native extension from `editors/zed` and use typed-sql as the sole TypeScript and TSX
server. The extension resolves the project-local package automatically, so no binary path or
machine-specific directory is required:

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
