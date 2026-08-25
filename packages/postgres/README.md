# @typed-sql/postgres

PostgreSQL grammar, catalog introspection, exact result inference, type policy, runtime codecs, and
an optional application-owned `pg` adapter for [typed-sql](https://github.com/Lojhan/typed-sql).

```sh
pnpm add @typed-sql/core@next @typed-sql/postgres@next pg
pnpm add -D @typed-sql/cli@next typescript@7.0.2
```

`pg` is intentionally not a dependency or peer dependency of this package. Your application chooses
its driver version, pool configuration, and lifecycle; the adapter loads it only when you import
`@typed-sql/postgres/pg`.

## Configure and generate

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: pg({
      connectionString: () => process.env.DATABASE_URL!,
      schemas: ["public"],
      typePolicy,
    }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

```sh
pnpm exec typed-sql generate
```

## Query and execute

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const query = sql`
  SELECT account.id, account.email, account.status, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
  ORDER BY account.id
`;

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
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

The default lossless policy maps PostgreSQL `bigint` to `bigint`, `numeric` to `string`, temporal
types to `Date`, JSON to `unknown`, enums to literal unions, arrays recursively, and `bytea` to
`Uint8Array`. Per-query parsers do not mutate `pg` globals and delegate non-policy OIDs to the
installed driver's native parser table. See the tested
[runtime codec matrix](https://github.com/Lojhan/typed-sql/blob/main/docs/CODEC_FIDELITY.md#postgresql-and-pg).

## Supported SQL

| Surface | Status | Notes |
| --- | --- | --- |
| Static tagged templates | Supported | Imports and aliases from `@typed-sql/postgres` are recognized. |
| `SELECT`, `DISTINCT`, `DISTINCT ON` | Supported | Static row-shape inference. |
| Tables, schemas, aliases and stars | Supported | Catalog lookup, ambiguity checks and `USING` column merging. |
| Inner and outer joins | Supported | Outer-join nullability propagates into result columns. |
| CTEs and derived/correlated/scalar subqueries | Supported | Recursive CTEs and unsafe scalar/IN arity diagnose. |
| Grouping, aggregates and windows | Supported | Includes common aggregates, `FILTER`, named and inline windows. |
| Expressions, `CASE`, casts and `$n` parameters | Supported | Parameters infer from columns, casts, DML targets, ranges, limits, and catalog functions; ambiguous positions remain `unknown`. |
| Arrays, enums, domains, JSON and catalog functions | Supported | Known types and function name/arity are validated. |
| `INSERT`, `UPDATE`, `DELETE`, `RETURNING` | Supported | Commands without `RETURNING` infer `Query<never, Parameters>`. |
| Set operations and `WITHIN GROUP` | Not supported | Fail safely during parsing. |
| Dynamic SQL or identifiers | No static inference | Use runtime values and `sql.ident()` explicitly. |

A feature not marked supported produces a diagnostic or `Query<unknown>`; it never receives an
optimistic row type. Introspection covers tables, views, columns, defaults, server version, arrays,
enums, domains and user functions.

MIT © typed-sql contributors
