# @typed-sql/compiler

The dialect-neutral TypeScript source compiler behind [typed-sql](https://github.com/Lojhan/typed-sql).
It finds static SQL templates, asks the configured grammar for row and parameter shapes, injects them into
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
or ambiguous SQL remains a diagnostic or an `unknown` position—never `any`. The resulting overlay
uses `Query<Row, readonly [Param1, Param2, ...]>`, which lets TypeScript report incorrect `${...}`
values at their original source locations.

Direct `sql.append(base, ...fragments)` expressions are analyzed cumulatively. The compiler resolves
the statically bound base query, adds each visible `sql.fragment` in source order, and injects the
grammar-derived parameter tuple into that fragment. Composed values are therefore checked against
their referenced columns even when a preceding fragment introduces structure such as
`WHERE 1 = 1`. Indirect function-returned fragments and arbitrary mutable collections remain at the
core runtime's parameter-safe boundary rather than being guessed.

Structural fragment interpolations inside a complete `sql` template are expanded as correlated,
finite branches. The compiler analyzes each resulting complete SQL statement, emits a conditional
row for generic boolean property selections, and injects expected parameter types into nested
fragments. `sql.empty` represents the absent branch without turning it into a driver parameter.
The expansion is a grammar-neutral intermediate representation: SQL parsing and resolution still
belong exclusively to `DialectPlugin.analyze()`.

`compileSource` accepts `maxStructuralVariants`, defaulting to 64. The compiler counts independent
conditions and returns `TSQ003` before invoking the grammar when the bound would be exceeded.
Repeated uses of the same condition are correlated and do not multiply the branch count. A shared
fragment that receives incompatible parameter expectations across valid branches fails closed with
`TSQ205`.

Application projects normally use this through `typed-sql check` or the language server. It is
public for grammar, editor, and build-tool integrations.

MIT © typed-sql contributors
