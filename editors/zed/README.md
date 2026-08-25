# typed-sql for Zed (experimental)

The Zed extension runs the project-local `@typed-sql/language-server`. It applies typed-sql's
in-memory query overlay before the pinned TypeScript 7.1 preview checks the program, so hovers on the
query and every downstream value contain the exact row type.

## Install in an application

From the application root:

```sh
pnpm add -D @typed-sql/language-server@next
```

Install this `editors/zed` directory with **zed: install dev extension**, then add:

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

No binary path is required. Resolution is deterministic: an explicit Zed binary setting wins, then
the extension uses the application package at
`node_modules/@typed-sql/language-server`, then a `typed-sql-language-server` on the worktree PATH,
and finally a typed-sql monorepo development build. If none exists, Zed reports the exact `pnpm add`
command instead of attempting an absolute development path.

`schemaPath` is optional; leaving it unset uses `schema.file` from the discovered config. In a
multi-root workspace, Zed starts per-worktree servers and the language server also routes every
workspace folder through its own config, installed grammar, schema, and TypeScript project.

## TypeScript server warning

typed-sql does not load the workspace's `tsserver.js`. TypeScript 7.0 may intentionally ship without
that legacy entrypoint, while typed-sql owns an isolated, pinned TypeScript 7.1 preview process. A
Zed warning that its built-in TypeScript integration fell back to a bundled TypeScript does not
describe typed-sql's process. Keeping only `typed-sql` in the language-server list removes the
competing `Query<unknown>` hover.

## Develop this repository

Run `pnpm build`, install this directory as a dev extension, and open
`e2e/postgres/src/query.ts`. The repository `.zed/settings.json` uses the monorepo fallback and the
PostgreSQL E2E config. Rebuild its committed snapshot with:

```sh
pnpm --filter @typed-sql/e2e-postgres generate:snapshot
```
