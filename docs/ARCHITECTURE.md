# Architecture

## 1.0 package boundary

typed-sql separates four concerns: the query contract, dialect grammar, database-driver
integration, and developer tooling.

| Package | Responsibility | Runtime driver dependency |
| --- | --- | --- |
| `@typed-sql/core` | SQL tag, `Query<Row, Parameters>`, database and compiler contracts | None |
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
- ordered parameter resolution, with `unknown` for positions the grammar cannot prove;
- database type to TypeScript type mapping;
- runtime parameter encoding and result decoding;
- feature and server-version capabilities.

Core also exposes reusable resolver mechanics—indexed table/column/function lookup, ordered
parameter collection, literal-union normalization, and name suggestions. These mechanics contain no
SQL rules. Each grammar remains responsible for its own parser behavior, identifiers, operators,
built-ins, nullability, type policy, feature gates, and diagnostics, so adding MSSQL or SQLite does
not require changing the compiler.

The compiler recognizes the `sqlModule` declared by the configured dialect and never branches on
a package name, dialect id, or concrete driver. This lets first-party and third-party grammars expose
the same package-root application contract. Contract version 2 requires both resolved result
columns and resolved parameters. Generated snapshots
record their dialect, dialect package version, server version, type policy and deterministic hashes.
The schema layer treats type policy as opaque data; its shape and defaults belong to the dialect.

Generated TypeScript is schema metadata for tooling and inspection. Application code imports
`sql` and the default `typePolicy` from the dialect root, then imports a driver adapter only when it
needs execution. A custom policy belongs in an application module shared by config and runtime;
it is never imported back from generated output.

Dynamic predicates use a two-stage contract. A static base query owns the inferred result row;
`SqlFragment<Parameters>` owns parameterized predicate segments; and `sql.where()` combines them
without parsing or concatenating user strings. `sql.and()`/`sql.or()` accept nullable fragment
tuples and preserve the source-order parameter type tuple. Applications can derive filter input
types from `QueryRow<typeof base>` so schema changes propagate into query-factory call sites.
`sql.append()` skips absent fragments, preserves the base row, concatenates parameter types, and
lets rendering renumber only the values that are present. The compiler analyzes directly visible
append fragments cumulatively with their statically bound base, so one fragment can introduce
`WHERE 1 = 1` and later fragments can resolve aliases and parameter types in that context. It
deliberately replaces object/string `+=`, which the JavaScript runtime would coerce to untyped
primitive strings.

Conditional projection and join structure remains SQL-first. A complete `sql` template may
interpolate `sql.fragment` or `sql.empty`; the compiler expands correlated conditional expressions,
analyzes the resulting complete statements, and combines their rows conditionally. The runtime
continues to flatten immutable segments and never interprets SQL clauses. Structural expansion is a
dialect-neutral compiler IR and is bounded before dialect analysis (64 variants by default,
configurable through `compiler.maxStructuralVariants`). Repeated conditions share one decision;
independent conditions that exceed the bound produce `TSQ003`.

## Correctness boundary

Only static SQL and supported grammar receive inferred types. Dynamic identifiers, unsupported
syntax, ambiguous resolution, or missing schema information produce diagnostics or
`Query<unknown, Parameters>`. Unresolved parameters remain `unknown`. They never silently produce
`any`.

Composed fragment values remain parameterized and type-preserving. Direct fragments in a static
`sql.append()` call receive cumulative grammar analysis; fragments hidden behind arbitrary runtime
functions or mutable collections do not. Structural fragment text must come from `sql.fragment`
templates or another explicit trusted fragment API; `sql.raw()` remains a deliberate escape hatch.

Editor inference is a development feature. CI correctness comes from the same compiler transform
through `typed-sql check`; runtime code does not depend on an editor being present.
