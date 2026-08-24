# typed-sql for Zed

This development extension runs the workspace build of `@typed-sql/language-server`. That server
proxies the pinned TypeScript 7.1 preview after applying typed-sql's in-memory source transform, so it
replaces Zed's normal TypeScript server for TypeScript and TSX in this worktree.

1. Run `pnpm build` at the repository root.
2. In Zed, run `zed: install dev extension` from the command palette.
3. Select this `editors/zed` directory.
4. Run `pnpm --filter @typed-sql/e2e-postgres generate:snapshot` to reproducibly rebuild the example
   from the committed catalog snapshot (or `pnpm e2e:postgres` with PostgreSQL running).
5. Open `e2e/postgres/src/query.ts` and hover `query`, `rows`, and `Actual`.

The repository's `.zed/settings.json` lists only `typed-sql` for TypeScript and TSX and points it at
the E2E schema. Do not add `"..."`, `vtsls`, or `typescript-language-server` to those arrays: those
servers see the original tag signature and will report `Query<unknown>` alongside the transformed
result. For another worktree, configure `schemaPath` under `lsp.typed-sql.settings` and set
`lsp.typed-sql.binary.path` to an installed `typed-sql-language-server` executable.
