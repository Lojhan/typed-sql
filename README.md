# typed-sql

typed-sql is a TypeScript 7 SQL compiler that turns static SQL templates into exact query-row
types from a versioned database snapshot. SQL remains the authoring language; the compiler, CLI,
Zed language server, and VS Code extension all consume the same installed dialect plugin.

The project is an early 0.2 release. PostgreSQL `SELECT` inference is usable and exercised against
a real PostgreSQL container, while the broader SQL surface in the 1.0 roadmap is not yet supported.
See [the PostgreSQL support matrix](./docs/POSTGRESQL_SUPPORT.md) before adopting it.

## Why the package split matters

Applications choose both their dialect and their driver. Installing a grammar never silently
installs a database client:

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
pnpm add -D @typed-sql/cli typescript@7.0.2
```

- `@typed-sql/core` owns `sql`, `Query<Row>`, the neutral query IR, and the dialect contract.
- `@typed-sql/postgres` owns PostgreSQL grammar, resolution, catalogs, codecs, and the optional
  `@typed-sql/postgres/pg` integration.
- `pg` is not declared by library packages. The application owns its version, installation, pool,
  configuration, and lifecycle.
- CLI and editor packages discover the dialect from `typed-sql.config.ts`; they do not depend on
  PostgreSQL.

## Configure and generate

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

const dialect = postgres();

export default defineConfig({
  dialect,
  schema: {
    file: "src/generated/db/schema.json",
    provider: pg({
      connectionString: () => process.env.DATABASE_URL!,
      schemas: ["public"],
      typePolicy: dialect.defaultTypePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy: dialect.defaultTypePolicy,
});
```

Then generate and check:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
```

Credentials stay in the config callback/environment and are not written to the generated package.
Generation produces a deterministic `schema.json` plus an `index.ts` that exports the core `sql`
tag, schema metadata, and the selected type policy—no driver or pool.

## Query and execute

```ts
import { createPgDatabase } from "@typed-sql/postgres/pg";
import { sql, typePolicy } from "./generated/db/index.js";

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
```

`pnpm verify` runs package-owned Poku tests, TypeScript 7 checks, coverage gates, public-package
graph rules, isolated tarball installation, and builds. The PostgreSQL E2E builds a digest-pinned
image, initializes a real schema, introspects it through the public CLI, checks types, executes the
query through application-owned `pg`, and proves both clean and failing drift paths.

Read [Architecture](./docs/ARCHITECTURE.md), [Roadmap](./docs/ROADMAP.md),
[Contributing](./CONTRIBUTING.md), [Releasing](./docs/RELEASING.md), and
[Security](./SECURITY.md) for the public project contract.
