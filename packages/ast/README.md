# @typed-sql/ast

The stable, bounded SQL tokenizer, parser, AST, and source-range package used by
[typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/ast
```

```ts
import { parseStatement, tokenize } from "@typed-sql/ast";

const tokens = tokenize("SELECT account.id FROM accounts AS account");
const statement = parseStatement("SELECT account.id FROM accounts AS account");
```

The parser supports PostgreSQL, MySQL, and SQLite syntax modes and preserves ranges for diagnostics, hover,
definitions, and quick fixes. Input length, token count, and parse nesting are resource-bounded.
Failures expose structured `SqlTokenizeError` or `SqlParseError` values with source ranges.
Grammar authors can use `walkStatement` to visit nested syntax with lexical CTE context while
retaining ownership of dialect semantics.

Application code normally imports `sql` from its selected dialect package instead.
See [Inference and safety](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/type-safety.md)
and the [diagnostic reference](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/diagnostics.md).

MIT © typed-sql contributors
