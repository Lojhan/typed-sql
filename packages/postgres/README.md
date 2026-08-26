# @typed-sql/postgres

The stable PostgreSQL grammar for [typed-sql](https://github.com/Lojhan/typed-sql), including
catalog introspection, row and parameter inference, type policy, runtime codecs, and an optional
application-owned `pg` adapter.

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript@7.0.2
```

`pg` is loaded only through `@typed-sql/postgres/pg`; it is not a dependency or peer dependency of
the grammar. Applications that stream rows also install the optional application-owned cursor:

```sh
pnpm add pg-cursor
```

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const query = sql`
  SELECT account.id, account.email, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
`;

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
});

const rows = await database.execute(query);

const accountById = database.prepare("account-by-id", (id: bigint) => sql`
  SELECT account.id, account.email
  FROM users AS account
  WHERE account.id = ${id}
`);

for await (const account of database.stream(accountById(42n), { batchSize: 500 })) {
  // account retains the query's inferred row type
}
```

The package root exports `sql`, `postgres`, and the PostgreSQL type policy. The `/pg` entrypoint
exports the schema provider and execution adapter; `/runtime` exposes driver-neutral PostgreSQL
rendering and codecs.

Read the [PostgreSQL grammar guide](https://github.com/Lojhan/typed-sql/blob/main/docs/dialects/postgresql.md),
[execution guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/execution.md),
[configuration](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md), and
[database type mappings](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/type-mappings.md).

MIT © typed-sql contributors
