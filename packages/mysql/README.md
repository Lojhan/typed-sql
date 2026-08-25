# @typed-sql/mysql

MySQL grammar, catalog introspection, exact result inference, type policy, runtime codecs, and an
optional application-owned `mysql2` adapter for [typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/core@next @typed-sql/mysql@next mysql2
pnpm add -D @typed-sql/cli@next typescript@7.0.2
```

`mysql2` is intentionally not a dependency or peer dependency of this package. It is loaded only
when an application imports `@typed-sql/mysql/mysql2`.

## Configure and generate

```ts
import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { mysql2 } from "@typed-sql/mysql/mysql2";

export default defineConfig({
  dialect: mysql({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: mysql2({
      connectionUri: () => process.env.DATABASE_URL!,
      schemas: ["app"],
      typePolicy,
    }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

## Query and execute

```ts
import { sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

const query = sql`
  SELECT account.id, account.email, account.status, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
  ORDER BY account.id
`;

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
  typePolicy,
});

const rows = await database.execute(query);
// readonly {
//   id: bigint;
//   email: string;
//   status: "active" | "suspended";
//   budget: string | null;
// }[]
```

The adapter enables lossless bigint/decimal defaults, explicit alternative codecs, catalog
introspection, and nested savepoints without changing global `mysql2` behavior. It rejects
`poolConfig` options that would contradict the selected type policy. See the tested
[runtime codec matrix](https://github.com/Lojhan/typed-sql/blob/main/docs/CODEC_FIDELITY.md#mysql-and-mysql2).

## Supported SQL

The grammar targets MySQL 8.4 LTS and supports aliases and stars, inner/outer/cross joins, CTEs,
derived and correlated subqueries, grouping, aggregates, windows, `CASE`, scalar/EXISTS/IN/BETWEEN
expressions, common JSON functions/operators, and `INSERT`/`UPDATE`/`DELETE` command typing. Catalog
inference covers enums, unsigned integers, decimals, JSON, dates, binary values and `tinyint(1)`
policy mapping. Ordered parameters infer from column comparisons, DML targets, casts, ranges,
limits, and cataloged function arguments; positions without enough evidence remain `unknown`.

Recursive CTE inference, `FULL JOIN`, array constructors, aggregate `FILTER` and incompatible
`RETURNING` clauses produce `TSQ401`. Commands without a result surface infer
`Query<never, Parameters>`.
Unknown functions warn and infer `unknown`; ambiguous or structurally unsafe queries are errors.

MIT © typed-sql contributors
