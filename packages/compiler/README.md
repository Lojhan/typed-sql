# @typed-sql/compiler

The stable, grammar-neutral TypeScript source compiler behind
[typed-sql](https://github.com/Lojhan/typed-sql). It finds static SQL templates, asks the configured
grammar for row and parameter shapes, creates an in-memory TypeScript overlay, and preserves source
mappings for diagnostics and editor tooling.

```sh
pnpm add @typed-sql/compiler
```

```ts
import { compileSource } from "@typed-sql/compiler";
import { postgres } from "@typed-sql/postgres";

const result = compileSource({
  source: 'import { sql } from "@typed-sql/postgres"; const q = sql`SELECT 1 AS value`;',
  dialect: postgres(),
  schema: { formatVersion: 1, dialect: "postgres", tables: {} },
});
```

`compileSource` consumes only `DialectPlugin`; it does not branch on a database, grammar package,
or driver. Compiled queries expose path-independent SHA-256 fingerprints, variant fingerprints,
and source-mapped semantics merged conservatively across conditional structure. Its public options include the structural-variant bound used for conditional fragments.
Application projects normally use the compiler through `typed-sql check` or the language server.

Read [Architecture](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/architecture.md),
[Compose conditional SQL](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/composition.md), and
[Inference and safety](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/type-safety.md).

MIT © typed-sql contributors
