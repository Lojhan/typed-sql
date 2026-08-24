# Migrating to 1.0

## Package boundary

The former generic `@typed-sql/runtime` package was removed. Runtime rendering and codecs now live
with their dialect:

- PostgreSQL: `@typed-sql/postgres/runtime`; optional driver bridge: `@typed-sql/postgres/pg`.
- MySQL: `@typed-sql/mysql/runtime`; optional driver bridge: `@typed-sql/mysql/mysql2`.

Install the driver in the application. No typed-sql package declares `pg` or `mysql2` as a regular,
optional, or peer dependency.

## Configuration

Create the dialect once and provide it to `defineConfig`. Editor and CLI tooling load that config;
they no longer assume PostgreSQL. Import `sql` and the default `typePolicy` directly from the
installed dialect package (`@typed-sql/postgres` or `@typed-sql/mysql`). Generated modules are
schema-only tooling artifacts and must not be imported by application code.

Replace pre-1.0 generated imports:

```ts
// Before
import { sql, typePolicy } from "./generated/db/index.js";

// 1.0
import { sql, typePolicy } from "@typed-sql/postgres";
```

## Schema format

Format 1 is the stable snapshot contract and every returned `SchemaSnapshot` now contains
`formatVersion: 1`. Pre-1.0 snapshots without a version remain readable and are normalized by
`parseSchemaSnapshot` or `migrateSchemaSnapshot`. Versions newer than the installed schema package
fail with an actionable error instead of being interpreted optimistically.

Regenerate snapshots before committing the 1.0 upgrade:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
```

## TypeScript

The correctness path requires TypeScript 7.0.2. The editor semantic bridge is pinned separately to
the tested TypeScript 7.1 preview snapshot and is replaceable when the upstream API stabilizes.
Unsupported or dynamic SQL resolves conservatively to a diagnostic or `Query<unknown>`, never
`any`.
