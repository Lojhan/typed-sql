# typed-sql language server

Editor-neutral stdio Language Server Protocol proxy for typed-sql. It transforms open TypeScript
and TSX documents, delegates the full semantic program to the pinned TypeScript 7.1 preview, maps
positions back to the original source, and merges SQL diagnostics. Consequently, downstream values
such as `rows` and `Actual` carry the inferred result—not only the tagged query hover.

```sh
pnpm build
pnpm --filter @typed-sql/language-server start
```

Initialization options and `workspace/didChangeConfiguration` accept:

```json
{
  "schemaPath": "generated/db/schema.json",
  "projectFile": "tsconfig.json",
  "nativePreview": true
}
```

Relative paths resolve from the LSP workspace root. The proxy is intended to be the editor's sole
TypeScript language server; running `vtsls` or another untransformed server beside it can display a
second `Query<unknown>` result.
