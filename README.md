# typed-sql

### Write SQL. Read TypeScript.

[![CI](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript 7](https://img.shields.io/badge/TypeScript-7.0.2-3178c6.svg)](./docs/reference/compatibility.md)
[![PostgreSQL, MySQL, SQLite](https://img.shields.io/badge/dialects-PostgreSQL%20%7C%20MySQL%20%7C%20SQLite-336791.svg)](./docs/index.md)

typed-sql is a TypeScript SQL compiler. It analyzes ordinary static SQL templates against a
snapshot of your real database, then carries the exact result and parameter types through your
application. SQL stays SQL: there is no query-builder DSL, generated query wrapper, or generated
application API.

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const accountId = 42n;

const query = sql`
  SELECT account.id, account.email, account.status, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
  WHERE account.id = ${accountId}
`;

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
});

const rows = await database.execute(query);
```

Hover `rows`:

```ts
readonly {
  id: bigint;
  email: string;
  status: "active" | "suspended";
  budget: string | null;
}[]
```

The type comes from the query, catalog, join nullability, database enum, and configured runtime
codecs. The interpolation is also checked as `bigint` because it is compared with `account.id`.

## Why typed-sql

- **Use your database language.** CTEs, joins, aggregates, window functions, database functions,
  DML, and dialect-specific behavior remain visible.
- **Infer rows and parameters.** A query carries both its result shape and ordered parameter tuple.
- **Keep the database authoritative.** The CLI generates a deterministic, reviewable catalog
  snapshot from PostgreSQL, MySQL, or SQLite.
- **Own your driver.** Grammar packages do not install `pg` or `mysql2`; the application chooses
  and configures its driver.
- **Fail closed.** Unsupported, ambiguous, or dynamic SQL produces a diagnostic or
  `Query<unknown>`, never `any` or an optimistic type.
- **Use one grammar contract.** The compiler, CLI, editor tooling, and third-party dialects all
  consume the same public interface.
- **Carry build evidence into production.** Deterministic query manifests correlate runtime
  fingerprints with inferred types, dependencies, and capabilities without storing SQL or values.
- **Prove inference against the database.** Optional native prepare metadata verifies safe variants
  and produces a deterministic, secret-free proof that CI can later validate offline.
- **Review optimizer evidence.** Optional structured plans and explicit budgets expose cost,
  cardinality, and node-shape regressions without executing application statements.
- **Check migrations against deployed queries.** Offline compatibility reports analyze both rolling-
  deployment directions and link breaks to exact query variants.
- **Route with semantic proof.** Opt-in routed databases send only proven-safe reads to
  application-owned replicas and support bounded retries for explicit transactions.
- **Use native bulk protocols without losing SQL.** Optional PostgreSQL COPY and MySQL LOAD DATA
  capabilities compile ordinary typed `INSERT` factories into backpressured application streams.
- **Validate only where runtime proof matters.** Attach any Standard Schema V1 validator to decoded
  results without adding a validator dependency or changing the unvalidated query path.

## Install

PostgreSQL:

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript@7.0.2
```

MySQL:

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

SQLite preview:

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript@7.0.2
```

Create `typed-sql.config.ts`, generate a schema snapshot, and check a query:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
pnpm exec typed-sql manifest
pnpm exec typed-sql verify --live
pnpm exec typed-sql verify
pnpm exec typed-sql explain --compare artifacts/plans.json
pnpm exec typed-sql compat --before before.schema.json --after after.schema.json --before-manifest before.queries.json --after-manifest after.queries.json
```

See [Installation](./docs/getting-started/installation.md),
[Configuration](./docs/getting-started/configuration.md), and
[Your first query](./docs/getting-started/first-query.md) for the complete setup.

## Compose SQL without a builder

Structural choices stay inside tagged SQL fragments, while interpolated values remain driver
parameters:

```ts
function accounts<const Select extends { readonly status: boolean }>(
  filters: { readonly status?: "active" | "suspended" | null },
  select: Select,
) {
  return sql`
    SELECT account.id, account.email
      ${select.status ? sql.fragment`, account.status` : sql.empty}
    FROM users AS account
    WHERE 1 = 1
      ${filters.status == null
        ? sql.empty
        : sql.fragment`AND account.status = ${filters.status}`}
  `;
}
```

Literal selections produce exact result shapes; runtime booleans produce the corresponding union.
See [Compose conditional SQL](./docs/guides/composition.md) for predicates, joins, identifiers, and
the structural-variant bound.

## Packages

| Package | Purpose | Track |
| --- | --- | --- |
| `@typed-sql/core` | Query, fragment, adapter, dialect, and diagnostic contracts | Stable |
| `@typed-sql/opentelemetry` | Optional redacted OpenTelemetry database tracing | Stable |
| `@typed-sql/ast` | Bounded tokenizer, parser, AST, and source ranges | Stable |
| `@typed-sql/schema` | Versioned snapshots, hashes, migrations, and drift | Stable |
| `@typed-sql/config` | Config discovery and loading | Stable |
| `@typed-sql/compiler` | Grammar-neutral source analysis, manifests, verification, plan governance, and migration reports | Stable |
| `@typed-sql/conformance` | Executable compatibility kit for SQL grammar packages | Stable |
| `@typed-sql/postgres` | PostgreSQL grammar, codecs, introspection, and optional `pg` adapter | Stable |
| `@typed-sql/mysql` | MySQL grammar, codecs, introspection, and optional `mysql2` adapter | Stable |
| `@typed-sql/sqlite` | SQLite grammar, sound dynamic typing, introspection, and optional `node:sqlite` adapter | Experimental |
| `@typed-sql/cli` | Snapshot, checking, drift, manifest, verification, plan, and compatibility commands | Stable |
| `@typed-sql/ts-bridge` | Isolated TypeScript preview integration | Experimental |
| `@typed-sql/language-server` | TypeScript semantic proxy and SQL editor features | Experimental |

## Documentation

- [Documentation site](https://lojhan.github.io/typed-sql/)
- [Documentation source](./docs/index.md)
- [Execution adapters](./docs/guides/execution.md)
- [Standard Schema result validation](./docs/guides/result-validation.md)
- [Bulk data transfer](./docs/guides/bulk-data.md)
- [Database observability](./docs/guides/observability.md)
- [Query manifests](./docs/guides/query-manifests.md)
- [Live database verification](./docs/guides/live-verification.md)
- [Query plan governance](./docs/guides/query-plan-governance.md)
- [Migration compatibility](./docs/guides/migration-compatibility.md)
- [Read routing and transaction retries](./docs/guides/routing-and-retries.md)
- [PostgreSQL grammar](./docs/dialects/postgresql.md)
- [MySQL grammar](./docs/dialects/mysql.md)
- [SQLite grammar](./docs/dialects/sqlite.md)
- [Inference and safety](./docs/concepts/type-safety.md)
- [Query API](./docs/reference/api.md)
- [Diagnostics](./docs/reference/diagnostics.md)
- [Editor setup](./docs/guides/editors.md)
- [Author a custom grammar](./docs/extending/custom-grammars.md)

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

MIT © typed-sql contributors
