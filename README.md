# typed-sql

### Write SQL. Read TypeScript.

[![CI](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

typed-sql checks SQL against a snapshot of your database and infers result rows and parameter types.
Keep your SQL, database driver, connections and migrations.

```ts
import { sql } from "@typed-sql/postgres";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
```

With the corresponding schema, the compiler proves:

```ts
Query<
  { id: bigint; email: string; status: "active" | "suspended" },
  readonly [bigint]
>
```

Interpolated values become driver parameters. Unsupported or ambiguous SQL receives a diagnostic or
`unknown`; typed-sql does not guess a safe-looking type.

## Try your first query

The [SQLite quickstart](./docs/getting-started/sqlite.md) creates a local database and takes a query
through checking and execution without a server. Existing applications can start with the
[PostgreSQL](./docs/getting-started/postgresql.md) or [MySQL](./docs/getting-started/mysql.md) quickstart.

The development loop is:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --project tsconfig.json --show-types
```

The project check follows query types across imports and checks their application consumers. It uses
the application's supported TypeScript 7 compiler and keeps source files unchanged. Use it as the
project's typechecking step before your transpiler or bundler.

Exact editor hovers use the optional experimental language server. Ordinary TypeScript declarations
remain conservative and can show `Query<unknown>` without analysis. See
[compiler and editor workflow](./docs/getting-started/compiler-and-editor.md).

## Keep your database stack

- **SQL stays SQL.** Use supported joins, CTEs, aggregates, window functions, DML and dialect syntax.
- **Types follow the query.** Infer result rows, nullability and ordered parameter tuples from schema evidence.
- **Connections stay yours.** Reuse an [existing pool](./docs/guides/existing-pools.md) or choose an explicit [execution adapter](./docs/guides/adapters.md).
- **Composition is explicit.** Use `sql.fragment`, `sql.empty` and `sql.ident` for structure; ordinary values remain parameters.

[Compose conditional and repeated SQL](./docs/guides/composition.md), inspect
[database type mappings](./docs/reference/type-mappings.md), or explore the
[runnable applications](./docs/examples/index.md).

## Editor setup

Install [typed-sql for VS Code](https://marketplace.visualstudio.com/items?itemName=lojhan.typed-sql)
and follow the [editor setup guide](./docs/guides/editors.md) for the native SDK and language server.
Zed and other LSP clients use the same optional server.

The stable compiler path uses TypeScript 7.0.2. The experimental editor backend owns its isolated
TypeScript 7.1 beta; applications do not replace their compiler to enable editor hovers.
[Supported runtimes, databases and exact versions](./docs/reference/compatibility.md).

## Go further

[Documentation](https://lojhan.github.io/typed-sql/) ·
[Query API](./docs/reference/api.md) ·
[JSON and portable adapters](./docs/reference/portable-adapters.md) ·
[SQL files](./docs/guides/sql-files.md) ·
[Inference and safety](./docs/concepts/type-safety.md)

Add [production controls](./docs/operations/index.md) when needed: drift detection, manifests,
live verification, optimizer-plan review, migration compatibility and observability are independent
of the first-query setup.

For contributions and maintainer procedures, read [CONTRIBUTING.md](./CONTRIBUTING.md).

MIT © typed-sql contributors
