# @typed-sql/core

The stable, driver- and grammar-neutral foundation of
[typed-sql](https://github.com/Lojhan/typed-sql). It defines queries, fragments, rendering,
database adapters, diagnostics, schema contracts, and the interface implemented by every SQL
grammar.

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
```

Application queries import `sql` from the selected grammar so the compiler can associate each
template with its dialect:

```ts
import { sql } from "@typed-sql/postgres";
import type { QueryParameters, QueryRow } from "@typed-sql/core";

const query = sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${42n}
`;

type Account = QueryRow<typeof query>;
type Parameters = QueryParameters<typeof query>;
```

Grammar and adapter authors can use `DialectPlugin`, `DIALECT_CONTRACT_VERSION`,
`assertDialectPlugin`, `createDatabase`, `renderQuery`, and the neutral resolver primitives from
the package root. The package has no parser, grammar, database driver, TypeScript compiler, or
editor dependency.

Read the [query API](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/api.md),
[architecture](https://github.com/Lojhan/typed-sql/blob/main/docs/concepts/architecture.md), and
[custom grammar guide](https://github.com/Lojhan/typed-sql/blob/main/docs/extending/custom-grammars.md).

MIT © typed-sql contributors
