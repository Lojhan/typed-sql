# PostgreSQL developer E2E

This package exercises typed-sql as a developer would use it:

1. build a PostgreSQL 18.4 image from a digest-pinned `Containerfile`;
2. initialize enums, a domain, tables, a view, a function, and seed rows;
3. run `typed-sql generate` against the real catalog;
4. inspect `generated/db/schema.json` and its schema-only TypeScript metadata module;
5. run `typed-sql check` against `src/query.ts` with TypeScript 7;
6. ask the TypeScript 7.1 preview bridge for the native `Query<{ ... }>` type;
7. execute the query through application-owned `pg` and `createPgDatabase`;
8. verify clean drift, alter the live schema, and verify `TSQ301`.

From the repository root, with Podman running:

```sh
pnpm e2e:postgres
```

Docker can be selected instead:

```sh
TYPED_SQL_CONTAINER_ENGINE=docker pnpm e2e:postgres
```

The database listens only on `127.0.0.1:55432`. Override the port with
`TYPED_SQL_E2E_PORT`. The container uses disposable storage and is stopped in a `finally` block.
Generated files are intentionally left under `generated/db` for inspection and are gitignored.

To exercise the editor bridge in VS Code, run `pnpm build`, open this package, and launch the
repository's **typed-sql extension** debug configuration. Its workspace setting points the
extension at `generated/db/schema.json`; hover `query` in `src/query.ts` to see the inferred type.

For Zed, open the repository root, run `pnpm build`, install `editors/zed` with **zed: install dev
extension**, and hover `query` in `src/query.ts`. The repository `.zed/settings.json` runs the
typed-sql stdio proxy as the sole TypeScript server and selects this generated schema and project
automatically. Hover `rows` or `Actual` to verify that the inferred row is part of the live
TypeScript semantic program.

For manual exploration, start the database with `compose.yaml`, then use:

```sh
pnpm generate
pnpm check
pnpm drift
```

To rebuild `generated/db` without starting PostgreSQL, use the committed catalog snapshot:

```sh
pnpm generate:snapshot
pnpm check
```

`schema/catalog.snapshot.json` is a credential-free mirror of the E2E catalog and makes editor
setup deterministic. `pnpm generate` remains the live-introspection path and replaces the generated
schema artifacts with the current database catalog. Application queries continue to import `sql`
from `@typed-sql/postgres`.

The username/password are fixed test-only credentials and must not be reused outside this local
ephemeral environment.
