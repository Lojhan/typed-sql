# typed-sql

### Write SQL. Read TypeScript.

[![CI](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/Lojhan/typed-sql/actions/workflows/ci.yml)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

typed-sql checks SQL against a snapshot of your database and infers result rows and parameter types.
Keep your SQL, database driver, connections and migrations.

[Try the playground](https://lojhan.github.io/typed-sql/playground) ·
[Get started](./docs/getting-started/index.md) ·
[Documentation](https://lojhan.github.io/typed-sql/)

```ts
import { sql } from "@typed-sql/postgres";

export const accountById = (id: bigint) => sql`
  SELECT u.id, u.email, t.name AS team_name
  FROM users AS u
  LEFT JOIN memberships AS m ON m.user_id = u.id
  LEFT JOIN teams AS t ON t.id = m.team_id
  WHERE u.id = ${id}
`;
```

Against the [commerce schema](./docs/examples/commerce-schema.md), the compiler infers:

```ts
Query<
  { id: bigint; email: string; team_name: string | null },
  readonly [bigint]
>
```

The left join keeps `team_name` nullable. Interpolated values become bound parameters.
Unsupported or ambiguous SQL receives a diagnostic or `unknown`.

## SQL files, named arguments, and positional bindings

### Named arguments

![Named bindings: a repeated userId, a rejected string argument, and a corrected bigint call](./docs/assets/typed-sql-named.svg)

Import a `.sql` file through a [build integration](./docs/integrations/index.md). A repeated name
is one factory argument and two bound values:

```sql
-- orders.sql
SELECT id, user_id, status FROM orders
WHERE user_id = :userId OR user_id = :userId
```

```ts
import ordersByCustomer from "./orders.sql";

const query = ordersByCustomer({ userId: 42n });
// Parameter tuple: readonly [bigint, bigint]
// ordersByCustomer({ userId: "42" }) → TypeScript error
```

### Positional bindings

![PostgreSQL positional bindings: reordering SQL occurrences updates the bound parameter tuple](./docs/assets/typed-sql-positional.svg)

PostgreSQL numbered parameters can repeat and appear in a different order:

```sql
-- account.sql
SELECT id, email FROM users
WHERE email <> $2 AND (id = $1 OR id = $1)
```

```ts
import account from "./account.sql";

const query = account(42n, "excluded@example.com");
// Factory arguments follow numeric order: id, email.
// Bound tuple follows SQL occurrences: readonly [string, bigint, bigint].
```

MySQL and SQLite `?` arguments follow occurrence order. Mixed styles, unused numeric gaps, and
incompatible repeated types produce diagnostics.

### Branded identities

![Branded identities: column configuration flows into inferred result rows and parameters](./docs/assets/typed-sql-brands.svg)

Add `UserId` and `OrderId` brands to schema columns to keep identities distinct in arguments and
results. See the
[SQL files and application identities walkthrough](./docs/examples/sql-files-and-identities.md).

## Compose collections and infer nested results

### Mapped inserts

![Mapped insert: a collection stays parameterized and adding a RETURNING column updates the result type](./docs/assets/typed-sql-map.svg)

Use `.map()` with explicit fragments for one insert over a runtime-sized collection:

```ts
interface NewProduct {
  id: bigint;
  sku: string;
  title: string;
  priceCents: number;
}

export function insertProducts(items: readonly NewProduct[]) {
  if (!items.length) throw new RangeError("At least one product is required");
  return sql`
    INSERT INTO products (id, sku, title, price_cents, active)
    VALUES ${items.map((item) => sql.fragment`
      (${item.id}, ${item.sku}, ${item.title}, ${item.priceCents}, ${true})
    `)}
    RETURNING id, sku, price_cents
  `;
}
```

Each item contributes bound values; the returned row is
`{ id: bigint; sku: string; price_cents: number }`. Dynamic collection lengths produce a readonly
parameter array; fixed-size fragment tuples can retain an exact parameter tuple.
[Multi-row inserts](./docs/examples/multi-row-insert.md) explains both forms.

### Nested JSON

![Nested JSON: renaming an object key in SQL updates the inferred shape while preserving nested item arrays](./docs/assets/typed-sql-json.svg)

PostgreSQL JSON constructors preserve the shape they build:

```ts
export const orderSummary = (id: bigint) => sql`
  SELECT jsonb_build_object(
    'status', o.status::text,
    'totalCents', o.total_cents,
    'customer', jsonb_build_object('email', u.email)
  ) AS document
  FROM orders AS o
  JOIN users AS u ON u.id = o.user_id
  WHERE o.id = ${id}
`;
// Row: { document: {
//   status: string; totalCents: number; customer: { email: string }
// } }
```

Nested JSON aggregation, CTEs, join nullability, and adapter results are also demonstrated in the
[commerce playground](https://lojhan.github.io/typed-sql/playground). Arbitrary stored JSON remains
conservative unless its shape is proven. See [JSON type mappings](./docs/reference/type-mappings.md).

## Grammar and driver compatibility

Grammars own SQL analysis; drivers are optional, explicit application dependencies.

| Grammar package | Supported database versions | Introspection and execution adapter | Tested driver / runtime |
| --- | --- | --- | --- |
| `@typed-sql/postgres` | PostgreSQL 14–18 | `@typed-sql/postgres/pg` | `pg` 8.23.1 |
| `@typed-sql/mysql` | MySQL 8.4 and 9.7 LTS | `@typed-sql/mysql/mysql2` | `mysql2` 3.24.6 |
| `@typed-sql/sqlite` | SQLite 3.39.0–3.54.1 | `@typed-sql/sqlite/node-sqlite` | `node:sqlite`: Node 22.13.0 and current 22, 24, 26 lines |
| `@typed-sql/sqlserver` | SQL Server 2017–2025; compatibility levels 140–170 | `@typed-sql/sqlserver/odbc` | `koffi` 3.3.7, Microsoft ODBC 18, Linux x64 |

Additional execution adapters accept application-owned clients:

| Client or platform | Grammar | Adapter in `@typed-sql/adapters` | Callback transactions |
| --- | --- | --- | --- |
| Cloudflare D1 | SQLite | `/d1` | No; native atomic batch |
| libSQL / Turso | SQLite | `/libsql` | Yes |
| Official SQLite Wasm: memory, OPFS, SAH-pool | SQLite | `/sqlite-wasm` | Yes |
| Neon HTTP | PostgreSQL | `/neon-http` | No; noninteractive batch |
| Neon WebSocket | PostgreSQL | `/neon-ws` | Yes |
| Postgres.js | PostgreSQL | `/postgres-js` | Yes |

These portable adapters buffer results and require compiled value plans or an application decoder.
D1 uses safe-number integers and STRICT tables. See
[portable adapters and transport limits](./docs/reference/portable-adapters.md).

Supported database ranges and exact tested versions are different. The
[full compatibility reference](./docs/reference/compatibility.md) records database patches,
canaries, runtime versions, and compiler requirements. Feature coverage varies by grammar; see the
[grammar support matrix](./docs/reference/grammar-support.md). Custom grammars use the
[public dialect contract](./docs/extending/custom-grammars.md).

## Try your first query

The [SQLite quickstart](./docs/getting-started/sqlite.md) creates a local database and takes a query
through checking and execution without a server. Existing applications can start with the
[PostgreSQL](./docs/getting-started/postgresql.md) or [MySQL](./docs/getting-started/mysql.md) quickstart.

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --project tsconfig.json --show-types
```

The project check follows query types across imports and checks application consumers. It uses the
application's supported TypeScript 7 compiler and keeps source files unchanged. Use it as the
project's typechecking step before your transpiler or bundler.

Exact editor hovers use the optional experimental language server. Ordinary TypeScript declarations
remain conservative and can show `Query<unknown>` without analysis. See
[compiler and editor workflow](./docs/getting-started/compiler-and-editor.md).

## Keep your database stack

- **Connections stay yours.** Reuse an [existing pool](./docs/guides/existing-pools.md) or choose an explicit [execution adapter](./docs/guides/adapters.md).
- **Composition is explicit.** Use `sql.fragment`, `sql.empty` and `sql.ident` for structure; ordinary values remain parameters. See [SQL composition](./docs/guides/composition.md).
- **SQL assets join deployment checks.** Imported queries participate in [manifests](./docs/guides/query-manifests.md), [live verification](./docs/guides/live-verification.md), [plan review](./docs/guides/query-plan-governance.md), and [migration compatibility](./docs/guides/migration-compatibility.md).

## Editor setup

Install [typed-sql for VS Code](https://marketplace.visualstudio.com/items?itemName=lojhan.typed-sql)
and follow the [editor setup guide](./docs/guides/editors.md) for the native SDK and language server.
Zed and other LSP clients use the same optional server.

The stable compiler path uses TypeScript 7.0.2. The experimental editor backend owns its isolated
TypeScript 7.1 beta; applications do not replace their compiler to enable editor hovers.

[Query API](./docs/reference/api.md) · [Runnable examples](./docs/examples/index.md) ·
[Inference and safety](./docs/concepts/type-safety.md) · [Contributing](./CONTRIBUTING.md)

MIT © typed-sql contributors
