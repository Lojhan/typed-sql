# typed-sql

### Write SQL. Hover the query. Get the exact row type.

[![CI](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript 7](https://img.shields.io/badge/TypeScript-7.0.2-3178c6.svg)](./docs/COMPATIBILITY.md)
[![PostgreSQL and MySQL](https://img.shields.io/badge/dialects-PostgreSQL%20%7C%20MySQL-336791.svg)](./docs/ARCHITECTURE.md)

typed-sql is a TypeScript 7 SQL compiler. It reads ordinary static SQL templates, resolves them
against a versioned snapshot of your real database, and makes the inferred result flow through your
application—without a query builder, generated query wrappers, or imports from a generated folder.

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const dashboardQuery = sql`
  WITH project_totals AS (
    SELECT organization_id, count(*) AS project_count, sum(budget) AS total_budget
    FROM projects
    GROUP BY organization_id
  )
  SELECT
    organizations.id AS organization_id,
    organizations.name,
    project_totals.project_count,
    project_totals.total_budget,
    organization_health(organizations.id) AS health
  FROM organizations
  LEFT JOIN project_totals ON project_totals.organization_id = organizations.id
  ORDER BY organizations.name
`;

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
});

const rows = await database.execute(dashboardQuery);
```

Hover `rows`:

```ts
readonly {
  organization_id: string;
  name: string;
  project_count: bigint | null;
  total_budget: string | null;
  health: "healthy" | "attention" | "idle" | null;
}[]
```

That type is not handwritten. It comes from the SQL, join nullability, aggregate semantics,
PostgreSQL function catalog, enum definition, configured runtime codecs, and your generated schema
snapshot. Change the query or schema and the type changes with it.

> **Release status:** the public beta is available from npm under the `next` dist-tag. Stable 1.0
> follows after external beta use and the acceptance gates in [Releasing](./docs/RELEASING.md).

## Why typed-sql feels different

- **SQL stays SQL.** CTEs, joins, subqueries, aggregates, window functions, database functions, DML,
  and dialect-specific syntax remain visible to your database team.
- **Types reach application values.** The query is `Query<Row>` and `database.execute(query)` is
  `readonly Row[]`; inference is not limited to a decorative SQL hover.
- **The database is the source of truth.** The CLI introspects real PostgreSQL or MySQL catalogs into
  a deterministic, reviewable snapshot.
- **No generated application API.** Application code imports `sql` from its installed dialect
  package. Generated files contain schema metadata only.
- **Drivers belong to the application.** Installing a grammar never installs `pg` or `mysql2`.
- **Unsupported SQL fails safely.** Ambiguous, dynamic, invalid, or unsupported SQL becomes a
  diagnostic or `Query<unknown>`—never `any` and never an optimistic lie.
- **One compiler everywhere.** CLI checks, Zed, VS Code, and third-party grammar plugins share the
  same dialect contract, schema model, inference engine, and diagnostic codes.

## Install the beta

PostgreSQL:

```sh
pnpm add @typed-sql/core@next @typed-sql/postgres@next pg
pnpm add -D @typed-sql/cli@next @typed-sql/language-server@next typescript@7.0.2
```

MySQL:

```sh
pnpm add @typed-sql/core@next @typed-sql/mysql@next mysql2
pnpm add -D @typed-sql/cli@next @typed-sql/language-server@next typescript@7.0.2
```

The driver is deliberately explicit. `@typed-sql/postgres` contains PostgreSQL grammar, catalog,
resolution, and codecs; `pg` is your runtime dependency. The MySQL boundary works the same way.

## Configure the database contract

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: pg({
      connectionString: () => process.env.DATABASE_URL!,
      schemas: ["public"],
      typePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

Generate the snapshot, verify a query through TypeScript 7, and detect schema drift:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
```

Credentials remain in your config callback or environment. They are never written to generated
files. Commit the generated snapshot so schema changes and type-policy changes are reviewable.

## Execute with the driver you chose

Interpolations become driver parameters. Identifiers and intentionally raw fragments are explicit:

```ts
const accountId = 42n;
const query = sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
  WHERE account.id = ${accountId}
`;

const rows = await database.execute(query);

const byColumn = sql`SELECT ${sql.ident("display_name")} FROM accounts`;
const trustedMigrationFragment = sql.raw("CURRENT_TIMESTAMP");
```

Use `sql.raw()` only for trusted static SQL. It is intentionally not an escaping API.

## Editor experience

The typed-sql language server is a complete TypeScript 7 semantic proxy: it applies the inferred
query overlay in memory, asks the native TypeScript checker for the real program type, and maps
hover/diagnostic positions back to the unchanged source.

- **Zed:** the repository includes a native extension and a project-local configuration. The
  typed-sql server replaces the ordinary TypeScript server so Zed does not show a competing
  `Query<unknown>`. See the [Zed guide](./editors/zed/README.md).
- **VS Code:** the experimental extension provides inferred hovers, SQL diagnostics, completion,
  definitions, quick fixes, cancellation, and bounded caches. See the
  [VS Code guide](./packages/vscode/README.md).
- **Any LSP client:** run `typed-sql-language-server --stdio` and provide the config/schema/project
  settings documented by [`@typed-sql/language-server`](./packages/language-server/README.md).

TypeScript `7.0.2` is the correctness compiler. A separately pinned `7.1` preview lives behind an
isolated process boundary for the editor bridge, so upstream API churn cannot leak into the grammar
or query contract.

## Packages

| Package | What it owns | Installs a DB driver? |
| --- | --- | --- |
| [`@typed-sql/core`](./packages/core/README.md) | `sql`, `Query<Row>`, neutral query IR, database and dialect contracts | No |
| [`@typed-sql/postgres`](./packages/postgres/README.md) | PostgreSQL grammar, catalog introspection, resolver, codecs, optional `/pg` adapter | No |
| [`@typed-sql/mysql`](./packages/mysql/README.md) | MySQL grammar, catalog introspection, resolver, codecs, optional `/mysql2` adapter | No |
| [`@typed-sql/cli`](./packages/cli/README.md) | `generate`, `check`, and `drift` commands | No |
| [`@typed-sql/language-server`](./packages/language-server/README.md) | Grammar-neutral TypeScript/LSP semantic proxy | No |
| [`@typed-sql/compiler`](./packages/compiler/README.md) | Static-query extraction, source transformation, and checking | No |
| [`@typed-sql/schema`](./packages/schema/README.md) | Versioned snapshots, deterministic generation, hashes, migrations, and drift | No |
| [`@typed-sql/config`](./packages/config/README.md) | Config discovery and executable TypeScript config loading | No |
| [`@typed-sql/ast`](./packages/ast/README.md) | Bounded SQL tokenizer, parser, AST, and source ranges | No |
| [`@typed-sql/ts-bridge`](./packages/ts-bridge/README.md) | In-memory TypeScript 7 query overlays and preview-process bridge | No |

This split is a contract, not an organizational preference. The compiler does not know package
names, database engines, or drivers. It loads the installed dialect from the project config.

## Supported SQL

PostgreSQL and MySQL both cover the static application surface needed for serious projects:

- aliases, stars, schema-qualified tables, and outer-join nullability;
- CTEs, derived/correlated/scalar subqueries, and common expressions;
- grouping, aggregates, windows, `CASE`, casts, enums, domains, JSON, arrays, dates, and binary data;
- catalog/user functions with conservative overload and nullability handling;
- `INSERT`, `UPDATE`, `DELETE`, and supported result surfaces;
- parameterized execution and nested transaction/savepoint adapters.

The exact dialect boundaries are versioned in the
[PostgreSQL package](./packages/postgres/README.md#supported-sql) and
[MySQL package](./packages/mysql/README.md#supported-sql) documentation.

## Proof, not promises

The release gate exercises what users actually install:

- package-owned Poku suites with 95% statement/line/function and 90% branch gates on critical code;
- 2,000 deterministic parser fuzz inputs and explicit parser/token resource limits;
- TypeScript `7.0.2` transformed-program checks and an isolated `7.1` preview semantic bridge;
- real, digest-pinned PostgreSQL `18.4` and MySQL `8.4.11` containers;
- catalog generation, exact type assertions, runtime execution, clean drift, and failing drift;
- packed tarballs installed in fresh consumers with no workspace links and no hidden drivers;
- fresh packed PostgreSQL and MySQL applications using application-owned `pg` and `mysql2`;
- VSIX packaging plus native Zed WASM build and tests.

Run the same local gates:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm e2e:postgres
pnpm e2e:mysql
pnpm e2e:packed
```

## Project contract

- [Architecture](./docs/ARCHITECTURE.md)
- [Compatibility and performance](./docs/COMPATIBILITY.md)
- [Releasing](./docs/RELEASING.md)
- [Diagnostic code registry](./packages/core/README.md#diagnostics)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

typed-sql is open source under the [MIT License](./LICENSE).
