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
> Core, compiler, schema, config, AST, PostgreSQL, MySQL, and CLI are the intended stable train;
> the preview-backed bridge, language server, and editor integrations remain experimental.

## Why typed-sql feels different

- **SQL stays SQL.** CTEs, joins, subqueries, aggregates, window functions, database functions, DML,
  and dialect-specific syntax remain visible to your database team.
- **Types flow in both directions.** The query is `Query<Row, Parameters>`: `database.execute(query)`
  is `readonly Row[]`, and each `${...}` value is checked against its SQL position.
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
  compiler: {
    // Bounds conditional SQL analysis before any grammar work starts.
    maxStructuralVariants: 64,
  },
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

const wrongId = "42";
// TypeScript error: string is not assignable to the bigint parameter inferred from account.id.
sql`SELECT account.id FROM accounts AS account WHERE account.id = ${wrongId}`;

const byColumn = sql`SELECT ${sql.ident("display_name")} FROM accounts`;
const trustedMigrationFragment = sql.raw("CURRENT_TIMESTAMP");
```

Use `sql.raw()` only for trusted static SQL. It is intentionally not an escaping API.

### Compose nullable filters safely

Keep the row-producing statement static, derive filter input types from that inferred row, and
compose optional predicates as fragments:

```ts
import type { QueryRow } from "@typed-sql/core";

const accountsBase = sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
`;

type Account = QueryRow<typeof accountsBase>;
type AccountFilters = {
  readonly status?: Account["status"] | null;
  readonly minimumId?: Account["id"] | null;
};

function accounts(filters: AccountFilters, mode: "all" | "any") {
  const predicates = [
    filters.status == null ? undefined : sql.fragment`account.status = ${filters.status}`,
    filters.minimumId == null ? undefined : sql.fragment`account.id >= ${filters.minimumId}`,
  ] as const;

  return sql.where(
    accountsBase,
    mode === "all" ? sql.and(predicates) : sql.or(predicates),
  );
}
```

The result keeps the base row and the ordered potential parameter tuple. Missing filters are omitted
at runtime, parentheses preserve boolean precedence, and an empty filter list becomes `WHERE TRUE`.
Values always remain driver parameters. Fragment SQL must remain a static tagged template; arbitrary
strings and `sql.raw()` are not promoted into statically trusted SQL.

For an imperative `WHERE 1 = 1` query factory, use `sql.append()`:

```ts
function postgresAccounts2(filters: AccountFilters) {
  const query = sql`
    SELECT account.id, account.email, account.status
    FROM users AS account
  `;

  return sql.append(
    query,
    sql.fragment` WHERE 1 = 1`,
    filters.status == null
      ? undefined
      : sql.fragment` AND account.status = ${filters.status}`,
    filters.minimumId == null
      ? undefined
      : sql.fragment` AND account.id >= ${filters.minimumId}`,
  );
}
```

Literal `query += fragment` cannot be type-safe in JavaScript because `+=` coerces both operands to
primitives and discards the fragment's parameter metadata. `sql.append()` expresses the same
control flow without string concatenation. Variadic arguments retain exact ordered parameter types;
a spread mutable `SqlFragment<...>[]` retains the allowed parameter union but cannot promise a fixed
tuple shape because its runtime length and order can vary.

The compiler analyzes these direct variadic fragments cumulatively as one statement. The first
fragment can introduce `WHERE`, and later fragments inherit the base aliases and preceding
structure. An interpolation such as `${"aaa"}` for `account.status` or `${123}` for a `bigint`
`account.id` is rejected by TypeScript. Fragments hidden behind arbitrary functions or mutable
runtime collections remain outside this contextual grammar analysis.

Conditional structure stays inside ordinary SQL templates. `sql.empty` is an immutable zero-length
fragment, so projections and filters can vary without introducing a parallel query-builder DSL:

```ts
function accounts<
  const Select extends { readonly status: boolean; readonly budget: boolean },
>(filters: AccountFilters, select: Select) {
  return sql`
    SELECT account.id, account.email
      ${select.status ? sql.fragment`, account.status` : sql.empty}
      ${select.budget ? sql.fragment`, account.budget` : sql.empty}
    FROM users AS account
    WHERE 1 = 1
      ${filters.status == null ? sql.empty : sql.fragment`AND account.status = ${filters.status}`}
  `;
}
```

The compiler correlates repeated conditions, expands the finite structural branches, and asks only
the installed grammar to analyze each complete SQL statement. Multiple literal `true`/`false`
selections produce exact result shapes; runtime booleans produce the corresponding union. Direct and
nested interpolation values are checked against one complete ordered parameter tuple.

Independent conditions can produce `2ⁿ` statements, so analysis is bounded before a grammar is
invoked. The default maximum is 64 variants and can be changed through
`compiler.maxStructuralVariants`; exceeding it reports `TSQ003` rather than consuming unbounded
editor or CI time.

## Editor experience

The experimental typed-sql language server is a complete TypeScript 7 semantic proxy: it applies the inferred
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

| Package | Release track | What it owns | Installs a DB driver? |
| --- | --- | --- | --- |
| [`@typed-sql/core`](./packages/core/README.md) | Stable | `sql`, `Query<Row, Parameters>`, neutral query IR, database and dialect contracts | No |
| [`@typed-sql/postgres`](./packages/postgres/README.md) | Stable | PostgreSQL grammar, catalog introspection, resolver, codecs, optional `/pg` adapter | No |
| [`@typed-sql/mysql`](./packages/mysql/README.md) | Stable | MySQL grammar, catalog introspection, resolver, codecs, optional `/mysql2` adapter | No |
| [`@typed-sql/cli`](./packages/cli/README.md) | Stable | `generate`, `check`, and `drift` commands | No |
| [`@typed-sql/compiler`](./packages/compiler/README.md) | Stable | Static-query extraction, source transformation, and checking | No |
| [`@typed-sql/schema`](./packages/schema/README.md) | Stable | Versioned snapshots, deterministic generation, hashes, migrations, and drift | No |
| [`@typed-sql/config`](./packages/config/README.md) | Stable | Config discovery and executable TypeScript config loading | No |
| [`@typed-sql/ast`](./packages/ast/README.md) | Stable | Bounded SQL tokenizer, parser, AST, and source ranges | No |
| [`@typed-sql/language-server`](./packages/language-server/README.md) | Experimental | Grammar-neutral TypeScript/LSP semantic proxy | No |
| [`@typed-sql/ts-bridge`](./packages/ts-bridge/README.md) | Experimental | In-memory TypeScript 7 query overlays and preview-process bridge | No |

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
- a cross-dialect fail-closed soundness corpus shared by grammars, compiler, CLI, bridge, and editor service;
- deterministic Biome formatting, import organization, and recommended lint rules;
- 2,000 deterministic parser fuzz inputs and explicit parser/token resource limits;
- explicit compiler, structural-expansion, resolver-index, and query-rendering performance budgets;
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
- [Public API and stability boundary](./docs/PUBLIC_API.md)
- [Inference soundness policy and corpus](./docs/SOUNDNESS.md)
- [PostgreSQL and MySQL runtime codec fidelity](./docs/CODEC_FIDELITY.md)
- [Compatibility and performance](./docs/COMPATIBILITY.md)
- [Releasing](./docs/RELEASING.md)
- [Diagnostic code registry](./packages/core/README.md#diagnostics)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)

typed-sql is open source under the [MIT License](./LICENSE).
