# @typed-sql/compiler

The dialect-neutral TypeScript source compiler behind [typed-sql](https://github.com/Lojhan/typed-sql).
It finds static SQL templates, asks the configured grammar for a row shape, injects that shape into
an in-memory TypeScript program, and preserves source mappings for diagnostics and editor tooling.

```sh
pnpm add @typed-sql/compiler@next
```

```ts
import { checkFile, compileSource, extractStaticQueries, mapSqlRange } from "@typed-sql/compiler";
import { postgres } from "@typed-sql/postgres";

const result = compileSource({
  source: 'import { sql } from "@typed-sql/postgres"; const q = sql`SELECT 1 AS value`;',
  dialect: postgres(),
  schema: { formatVersion: 1, dialect: "postgres", tables: {} },
});
```

`compileSource` does not branch on PostgreSQL, MySQL, package names, or database drivers. It only
consumes the public `DialectPlugin` contract from `@typed-sql/core`. Unsupported, dynamic, invalid,
or ambiguous SQL remains a diagnostic or `Query<unknown>`—never `any`.

Application projects normally use this through `typed-sql check` or the language server. It is
public for grammar, editor, and build-tool integrations.

MIT © typed-sql contributors
