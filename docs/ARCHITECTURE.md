# Architecture

## 1.0 package boundary

typed-sql separates four concerns: the query contract, dialect grammar, database-driver
integration, and developer tooling.

| Package | Responsibility | Runtime driver dependency |
| --- | --- | --- |
| `@typed-sql/core` | SQL tag, `Query<Row>`, database and compiler contracts | None |
| `@typed-sql/compiler` | Dialect-neutral extraction, transforms and diagnostics | None |
| `@typed-sql/postgres` | PostgreSQL grammar, catalog model, resolver and codecs | Optional `pg` peer only |
| `@typed-sql/mysql` | MySQL grammar, catalog model, resolver and codecs | Optional `mysql2` peer only |
| `@typed-sql/cli` | Generation, checking and provider discovery | None by default |
| `@typed-sql/language-server` | TypeScript semantic proxy and editor protocol | None |

Applications opt into one dialect and one driver:

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
```

Adding PostgreSQL support must not install MySQL, SQLite, or their drivers.

## Driver rule

Core, compiler, schema-model and grammar entrypoints must not list `pg`, `mysql2`, or another driver
under `dependencies` or `optionalDependencies`. A dialect package may:

1. refer to a driver's public types with erased `import type` declarations;
2. declare the driver as an optional peer with a broad tested compatibility range;
3. load the peer lazily only from a driver-specific adapter or accept a structurally typed driver
   instance supplied by the application;
4. list the driver under `devDependencies` for its own tests.

The normal grammar/parser/resolver import path must work when no driver is installed. Calling live
introspection or runtime execution without the selected peer must fail with an actionable install
message.

This avoids hidden database clients, duplicate pools, unnecessary install size, and driver-version
ownership by typed-sql. npm also documents that an optional peer is not automatically installed,
which preserves explicit application ownership of the driver.

## Dialect contract

Every dialect implements a stable contract covering:

- parsing and source ranges;
- identifier/case and parameter rules;
- catalog snapshot validation and introspection;
- expression and result-column resolution;
- database type to TypeScript type mapping;
- runtime parameter encoding and result decoding;
- feature and server-version capabilities.

The compiler consumes this contract and never branches on a concrete driver. Generated snapshots
record their dialect, dialect package version, server version, type policy and deterministic hashes.

## Correctness boundary

Only static SQL and supported grammar receive inferred types. Dynamic identifiers, unsupported
syntax, ambiguous resolution, or missing schema information produce diagnostics or
`Query<unknown>`. They never silently produce `any`.

Editor inference is a development feature. CI correctness comes from the same compiler transform
through `typed-sql check`; runtime code does not depend on an editor being present.
