# typed-sql

An experimental PostgreSQL-first compiler that infers query row types from SQL and a generated
schema snapshot. SQL remains the authoring language while TypeScript 7 sees the resolved result as
part of its semantic program.

The project is pre-1.0 and its package boundaries are still evolving. The 1.0 architecture keeps
core and grammar packages driver-independent: applications opt into a dialect and install their
chosen driver separately. See [Architecture](./docs/ARCHITECTURE.md) and the
[1.0 roadmap](./docs/ROADMAP.md).

## Requirements

- Node.js 22 or newer
- pnpm 10
- TypeScript 7 (pinned and enforced by this workspace)

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:postgres
```

`pnpm e2e:postgres` builds the digest-pinned PostgreSQL image, loads the fixture schema, generates
the database package through the public CLI, checks an application query with TypeScript 7,
executes it against PostgreSQL, and proves both clean and failing drift checks. Podman is the
default; set `TYPED_SQL_CONTAINER_ENGINE=docker` to use Docker. See
[`e2e/postgres`](./e2e/postgres/README.md) for the inspectable developer workflow.

Check one source file:

```sh
node packages/cli/dist/packages/cli/src/cli.js check \
  --file test/fixtures/success/query.ts \
  --schema test/fixtures/success/schema.json \
  --project test/fixtures/success/tsconfig.json
```

Generate a package from an existing snapshot:

```sh
node packages/cli/dist/packages/cli/src/cli.js generate \
  --snapshot schema.json \
  --out src/generated/db
```

Generate directly from PostgreSQL without persisting credentials:

```sh
node packages/cli/dist/packages/cli/src/cli.js generate \
  --provider postgres \
  --url "$DATABASE_URL" \
  --schemas public \
  --out src/generated/db
```

Check schema drift against the database:

```sh
node packages/cli/dist/packages/cli/src/cli.js drift \
  --schema src/generated/db/schema.json \
  --provider postgres \
  --url "$DATABASE_URL"
```

Use the PostgreSQL runtime adapter:

```ts
import { createPostgresDatabase, sql } from "@typed-sql/runtime";

const db = createPostgresDatabase({ connectionString: process.env.DATABASE_URL });

try {
  const rows = await db.execute(sql`SELECT id FROM users`);
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT id FROM users WHERE id = ${1}`);
  });
} finally {
  await db.close();
}
```

Pass `typePolicy` to the generator and runtime adapter together. `bigint: "number"` rejects values
outside JavaScript's safe-integer range, and `numeric: "Decimal"` requires a `decimal` factory.

`sql.raw()` is intentionally unsafe and should only receive trusted, static SQL. Ordinary
template interpolations are parameters; use `sql.ident()` for a quoted identifier and
`sql.value()` for an explicit value fragment.

## Experimental editor integrations

`packages/language-server` is a standalone stdio LSP proxy. It transforms each open document and
delegates TypeScript diagnostics, hover, completion, navigation, and refactoring to the exact-pinned
TypeScript 7.1 preview. Consequently, the inferred row type is part of the editor's semantic program:
hovering `rows` and downstream aliases such as `Actual` shows the resolved object rather than
`unknown`. SQL diagnostics are merged into the TypeScript results and mapped back to the unchanged
source document.

For Zed, run `pnpm build`, use **zed: install dev extension**, and select `editors/zed`. The checked-in
`.zed/settings.json` makes typed-sql the TypeScript/TSX language server for the PostgreSQL E2E
package; running it beside `vtsls` would reintroduce a second `Query<unknown>` result. See
[`editors/zed`](./editors/zed/README.md) for the exact workflow.

`packages/vscode` remains the VS Code-specific adapter. See
[`packages/vscode`](./packages/vscode/README.md) for its debug configuration and fallback behavior.

See [Architecture](./docs/ARCHITECTURE.md) for the package contract,
[CONTRIBUTING.md](./CONTRIBUTING.md) for development, and [SECURITY.md](./SECURITY.md) for private
vulnerability reporting.
