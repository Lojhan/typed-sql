# @typed-sql/mysql

The stable MySQL grammar for [typed-sql](https://github.com/Lojhan/typed-sql), including catalog
introspection, row and parameter inference, type policy, runtime codecs, and an optional
application-owned `mysql2` adapter.

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

`mysql2` is loaded only through `@typed-sql/mysql/mysql2`; it is not a dependency or peer dependency
of the grammar.

```ts
import { sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

const query = sql`
  SELECT account.id, account.email, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
`;

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
  typePolicy,
});

const rows = await database.execute(query);
```

The package root exports `sql`, `mysql`, and the MySQL type policy. The `/mysql2` entrypoint exports
the schema provider and execution adapter; `/runtime` exposes driver-neutral MySQL rendering and
codecs.

Read the [MySQL grammar guide](https://github.com/Lojhan/typed-sql/blob/main/docs/dialects/mysql.md),
[configuration](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md), and
[database type mappings](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/type-mappings.md).

MIT © typed-sql contributors
