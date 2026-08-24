# Architecture

## 1.0 package boundary

typed-sql separates four concerns: the query contract, dialect grammar, database-driver
integration, and developer tooling.

| Package | Responsibility | Runtime driver dependency |
| --- | --- | --- |
| `@typed-sql/core` | SQL tag, `Query<Row>`, database and compiler contracts | None |
| `@typed-sql/config` | Neutral project config discovery/loading | None |
| `@typed-sql/schema` | Snapshot format, generation, hashes and drift | None |
| `@typed-sql/compiler` | Dialect-neutral extraction, transforms and diagnostics | None |
| `@typed-sql/postgres` | PostgreSQL grammar, catalog model, resolver and codecs | None; app installs `pg` |
| `@typed-sql/mysql` | MySQL grammar, catalog model, resolver and codecs | None; app installs `mysql2` |
| `@typed-sql/cli` | Generation, checking and provider discovery | None by default |
| `@typed-sql/language-server` | Configured-dialect TypeScript semantic proxy and editor protocol | None |

Applications opt into one dialect and one driver:

```sh
pnpm add @typed-sql/core @typed-sql/postgres pg
```

Adding PostgreSQL support must not install MySQL, SQLite, or their drivers.

## Driver rule

Core, compiler, schema-model and grammar entrypoints must not list `pg`, `mysql2`, or another runtime
driver under `dependencies` or `optionalDependencies`. A dialect package may:

1. refer to a driver's public types with erased `import type` declarations;
2. publish a declarations-only package such as `@types/pg` as a dependency when its public adapter
   declarations require it, while keeping the runtime driver itself application-owned;
3. load the application dependency lazily only from a driver-specific adapter or accept a structurally typed driver
   instance supplied by the application;
4. list the driver under `devDependencies` for its own tests.

The normal grammar/parser/resolver import path must work when no driver is installed. Calling live
introspection or runtime execution without the selected application driver must fail with an actionable install
message.

This avoids hidden database clients, duplicate pools, unnecessary install size, and driver-version
ownership by typed-sql. The packed-consumer gate verifies the driver is actually absent rather than
relying on package-manager-specific optional-peer behavior.

## Dialect contract

Every dialect implements a stable contract covering:

- the exact package-root module that exports its application `sql` tag;
- parsing and source ranges;
- identifier/case and parameter rules;
- catalog snapshot validation and introspection;
- expression and result-column resolution;
- database type to TypeScript type mapping;
- runtime parameter encoding and result decoding;
- feature and server-version capabilities.

The compiler recognizes the `sqlModule` declared by the configured dialect and never branches on
a package name, dialect id, or concrete driver. This lets first-party and third-party grammars expose
the same package-root application contract. Generated snapshots
record their dialect, dialect package version, server version, type policy and deterministic hashes.
The schema layer treats type policy as opaque data; its shape and defaults belong to the dialect.

Generated TypeScript is schema metadata for tooling and inspection. Application code imports
`sql` and the default `typePolicy` from the dialect root, then imports a driver adapter only when it
needs execution. A custom policy belongs in an application module shared by config and runtime;
it is never imported back from generated output.

## Correctness boundary

Only static SQL and supported grammar receive inferred types. Dynamic identifiers, unsupported
syntax, ambiguous resolution, or missing schema information produce diagnostics or
`Query<unknown>`. They never silently produce `any`.

Editor inference is a development feature. CI correctness comes from the same compiler transform
through `typed-sql check`; runtime code does not depend on an editor being present.
