# typed-sql

typed-sql is a TypeScript 7 SQL compiler that turns static SQL templates into exact query-row
types from a versioned database snapshot. SQL remains the authoring language; the compiler, CLI,
Zed language server, and VS Code extension all consume the same installed dialect plugin.

Version 1.0 defines the stable contract. PostgreSQL and MySQL inference, catalog
generation, editor integration, driver adapters, and drift detection are exercised against real
digest-pinned database containers. Review the dialect support matrices before adopting it.

## Why the package split matters

Applications choose both their dialect and their driver. Installing a grammar never silently
installs a database client:

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

- `@typed-sql/core` owns `sql`, `Query<Row>`, the neutral query IR, and the dialect contract.
- `@typed-sql/postgres` owns PostgreSQL grammar, resolution, catalogs, codecs, and the optional
  `@typed-sql/postgres/pg` integration.
- `@typed-sql/mysql` owns the equivalent MySQL surface and optional
  `@typed-sql/mysql/mysql2` integration.
- `pg` and `mysql2` are not declared by library packages. The application owns driver version, installation, pool,
  configuration, and lifecycle.
- A grammar may install declarations-only support such as `@types/pg` so its optional adapter is
  typecheckable immediately; this never installs or loads the runtime driver.
- CLI and editor packages discover the dialect from `typed-sql.config.ts`; they do not depend on
  PostgreSQL.

## Configure and generate

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

const dialect = postgres({ typePolicy });

export default defineConfig({
  dialect,
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

Then generate and check:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
```

Credentials stay in the config callback/environment and are not written to generated files.
Generation produces a deterministic `schema.json` plus a schema-only `index.ts` for inspection.
Application code never imports generated files; CLI and editor tooling associate the configured
schema with the dialect package's `sql` export.

## Query and execute

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const query = sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${1n}
`;

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
});

try {
  const rows = await database.execute(query);
  // readonly { id: bigint; email: string }[] in transformed TypeScript 7 programs
} finally {
  await database.close();
}
```

Ordinary interpolations become values. Use `sql.ident()` for quoted identifiers and reserve
`sql.raw()` for trusted static SQL. Dynamic/unsupported SQL must fail safely with a diagnostic or
`Query<unknown>`; it must never become `any` or a confidently wrong row type.

## TypeScript 7 and editors

The workspace strictly pins TypeScript `7.0.2` for builds and a separately aliased `7.1.0-dev`
snapshot for the native semantic bridge. `scripts/require-typescript-7.mjs` rejects a non-7.x
compiler. The preview bridge applies an in-memory query overlay, asks TypeScript for the real type,
and maps positions back to the unchanged source.

For Zed, build and install `editors/zed` as a dev extension. For VS Code, launch the included
extension development configuration. Both discover `typed-sql.config.ts`; optional `configPath`,
`schemaPath`, and `projectFile` settings are only overrides. See the
[Zed guide](./editors/zed/README.md) and [language-server guide](./packages/language-server/README.md).

## Develop and verify

Requirements are Node.js 22.11+, pnpm 10.32.1, and Podman or Docker for the real database suite.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm e2e:postgres
pnpm e2e:mysql
```

`pnpm verify` runs package-owned Poku tests, TypeScript 7 checks, coverage gates, public-package
graph rules, isolated tarball installation, and builds. The PostgreSQL E2E builds a digest-pinned
image, initializes a real schema, introspects it through the public CLI, checks types, executes the
query through the application-owned driver, and proves both clean and failing drift paths.

Read [Architecture](./docs/ARCHITECTURE.md), [Roadmap](./docs/ROADMAP.md),
[Contributing](./CONTRIBUTING.md), [Releasing](./docs/RELEASING.md), and
[Security](./SECURITY.md) for the public project contract. The stable
[diagnostics](./docs/DIAGNOSTICS.md), [compatibility matrix](./docs/COMPATIBILITY.md),
[PostgreSQL support](./docs/POSTGRESQL_SUPPORT.md), [MySQL support](./docs/MYSQL_SUPPORT.md), and
[1.0 migration guide](./docs/MIGRATING_TO_1.0.md) are versioned alongside the implementation.
