# @typed-sql/core

The driver- and dialect-neutral foundation of [typed-sql](https://github.com/Lojhan/typed-sql).
It owns the `sql` tagged template, `Query<Row>`, safe query fragments, rendering contract, database
adapter contract, diagnostics, and the interface implemented by every SQL grammar.

Most applications install it alongside one dialect:

```sh
pnpm add @typed-sql/core@next @typed-sql/postgres@next pg
```

Application queries import `sql` from the dialect root so tooling can associate the query with the
correct grammar:

```ts
import { sql } from "@typed-sql/postgres";

const query = sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${42n}
`;
```

`@typed-sql/core` is directly useful to grammar and adapter authors:

```ts
import {
  DIALECT_CONTRACT_VERSION,
  createDatabase,
  defineConfig,
  renderQuery,
  rowTypeLiteral,
  sql,
  type DialectPlugin,
  type Query,
  type SchemaSnapshot,
} from "@typed-sql/core";
```

The package has no database, parser, grammar, driver, TypeScript compiler, or editor dependency.
See the [architecture contract](https://github.com/Lojhan/typed-sql/blob/main/docs/ARCHITECTURE.md)
and [root documentation](https://github.com/Lojhan/typed-sql#readme).

## Diagnostics

Diagnostic meanings become stable at 1.0. Consumers should key automation on `code`, not English
message text. The machine-readable registry is exported as `diagnosticRegistry`.

| Range | Meaning |
| --- | --- |
| `TSQ001` | SQL syntax error |
| `TSQ002` | Parser resource limit exceeded |
| `TSQ007` | Dialect/snapshot contract mismatch |
| `TSQ100`–`TSQ108` | Catalog lookup, ambiguity, output naming, and cast errors |
| `TSQ202`–`TSQ204` | Unknown/ambiguous functions and unsafe operator inference |
| `TSQ210`–`TSQ217` | CTE, DML arity, join, and subquery safety errors |
| `TSQ301` | Schema or type-policy drift |
| `TSQ401` | Deliberately unsupported dialect surface |

MIT © typed-sql contributors
