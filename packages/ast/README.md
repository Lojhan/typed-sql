# @typed-sql/ast

The bounded SQL tokenizer, parser, AST, and source-range package used by
[typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/ast@next
```

```ts
import { parseStatement, tokenize } from "@typed-sql/ast";

const tokens = tokenize("SELECT account.id FROM accounts AS account");
const statement = parseStatement("SELECT account.id FROM accounts AS account");
```

The parser supports PostgreSQL and MySQL syntax modes and preserves ranges for diagnostics, hover,
definitions, and quick fixes. It is deliberately resource-bounded:

- maximum SQL length: 1,000,000 characters;
- maximum token count: 100,000;
- maximum parse nesting: 128 levels;
- structured `SqlTokenizeError` and `SqlParseError` failures with source ranges.

This is a compiler/tooling package; application code normally imports `sql` from
`@typed-sql/postgres` or `@typed-sql/mysql` instead. Unsupported syntax fails safely rather than
creating an optimistic type.

See the [supported SQL matrices](https://github.com/Lojhan/typed-sql#supported-sql) and
[diagnostic contract](https://github.com/Lojhan/typed-sql/tree/main/packages/core#diagnostics).

MIT © typed-sql contributors
