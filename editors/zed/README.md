# typed-sql for Zed

> Experimental: the extension distribution and preview TypeScript integration may change.

The Zed extension runs the project's installed `@typed-sql/language-server`, applying the inferred
query overlay before TypeScript checks the program.

From the application root:

```sh
pnpm add -D @typed-sql/language-server
```

Install this `editors/zed` directory with **zed: install dev extension**, then configure typed-sql as
the sole TypeScript and TSX server:

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
        "projectFile": "tsconfig.json",
        "nativePreview": true
      }
    }
  }
}
```

No binary path is required. The extension resolves an explicit Zed setting first, then the local
package, a worktree `PATH` binary, and finally a typed-sql monorepo development build. `schemaPath`
is optional; without it, the server uses `schema.file` from the config.

TypeScript 7 may omit the legacy `tsserver.js` expected by Zed's built-in integration. typed-sql
does not use that file. Disabling the competing servers prevents their conservative
`Query<unknown>` hover from appearing beside typed-sql's transformed type.

Read the complete [editor setup guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/editors.md).

MIT © typed-sql contributors
