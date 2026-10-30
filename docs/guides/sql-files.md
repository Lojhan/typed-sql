---
title: SQL file imports
pageType: how-to
description: Import SQL files as typed query factories with stable build integrations or the optional TypeScript 7.1 content mapper.
---

# SQL file imports

Each `.sql` file contains one statement and exports a query factory returning the same
`Query<Row, Parameters>` accepted by `database.all`, `one`, and `maybeOne`.

## Stable build and test workflow

Use [`@typed-sql/build`](../integrations/index.md) with your bundler or test runner. Generate
co-located `.d.sql.ts` declarations with `typed-sql-build types` and enable
`allowArbitraryExtensions` in your TypeScript configuration. No TypeScript beta is required.
Run generation before checking and use `typed-sql-build types --check` to verify committed
outputs in CI. Build adapters validate the current SQL and attach checked runtime value plans.

The [installation tutorials](../integrations/index.md) cover Vite/Vitest, Jest, webpack, Rspack,
Rsbuild, Next.js, esbuild, Rollup, Rolldown, Bun, native Node test runners, Astro, Nuxt,
SvelteKit, and Wrangler/D1.

## Experimental live content mapper

The `@typed-sql/ts-bridge` content mapper checks `.sql` imports directly against the configured
snapshot, without a declaration-generation step. It is tested with TypeScript **7.1.0-beta**.
TypeScript 7.0 and older do not support this content mapper. Use this optional frontend for
live TypeScript checking of SQL assets; the stable build integrations supply runtime compilation.

## Configure checking

Install the bridge and TypeScript beta alongside your selected grammar:

```sh
pnpm add @typed-sql/postgres @typed-sql/ts-bridge
pnpm add -D typescript@beta
```

Keep your normal [typed-sql configuration](../getting-started/configuration.md), including
`dialect`, `schema.file`, and `outDir`. Generate the snapshot with your normal introspection workflow
before checking SQL files. The mapper reads that snapshot; it does not call the configured provider
or connect to a database.

Add the mapper to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2024",
    "module": "NodeNext"
  },
  "contentMappers": [
    {
      "package": "@typed-sql/ts-bridge",
      "extensions": [".sql"]
    }
  ],
  "include": ["src"]
}
```

If the typed-sql config is elsewhere, set the mapper's `options.config` path relative to the
TypeScript project directory. Each project uses one typed-sql configuration and one grammar.

Run the native compiler with explicit permission to execute the mapper:

```sh
pnpm exec tsc --runExternalCode
pnpm exec tsc --runExternalCode --watch
```

`noEmit: true` is required. This frontend supplies typechecking, not JavaScript or declaration emit.
An emit-enabled mapper project reports an error. The native watch process observes the schema,
typed-sql configuration, and its imported local configuration modules.

## Bind positional parameters

Write `src/find-user.sql`:

```sql
SELECT id, email
FROM users
WHERE id = $1 AND email <> $2
```

Import and bind it from TypeScript:

```ts
import findUser from "./find-user.sql";

const query = findUser(1n, "excluded@example.com");
const rows = await database.all(query);
```

The configured grammar and snapshot determine the parameter tuple and result row. In this example,
a bigint `id` and text `email` produce `readonly [bigint, string]`. A file without placeholders
exports a zero-argument factory. Incorrect argument types or counts are TypeScript errors.

PostgreSQL uses `$1`, `$2`, and so on. MySQL and SQLite use `?` in binding order. Each positional
parameter must appear exactly once in order. Repeated, reordered, or gapped numbered placeholders
report a source diagnostic. Named parameters and structural interpolation are unsupported in this
frontend; use [explicit inline composition](./composition.md) when
the SQL structure varies. Placeholders inside strings, quoted identifiers, or comments remain text.
MySQL placeholder scanning uses the snapshot's recorded SQL mode.

SQL errors are reported against the original `.sql` file. Invalid SQL does not expose a callable
typed factory and the runtime loader rejects the module. The runtime binds values through
`sql.value`; user values never become structural SQL. Configure the database adapter with the same
[type policy](../reference/type-mappings.md) used for checking, just as with inline queries.

## Run on Node

Install `@typed-sql/build` as an application dependency for this runtime path. It requires
Node.js **24.11.1 or newer**; Node.js 25 requires 25.1.0 or newer. Start the ESM application
from its typed-sql configuration directory:

```sh
node --import @typed-sql/build/register src/main.ts
```

The preload evaluates one configuration from the current working directory, reads its snapshot,
and installs Node's synchronous module hooks. Node's built-in type stripping runs the example's
TypeScript entrypoint directly; its normal restrictions on erasable TypeScript syntax apply.
Restart the process after runtime configuration or snapshot changes. The compiler's watch refresh and Node's module cache are separate lifecycles.

Deploy the original `.sql` assets at the paths imported by your JavaScript, together with the
typed-sql configuration, its local dependencies, and the snapshot. For example, an emitted
`dist/main.js` importing `./find-user.sql` needs `dist/find-user.sql`. Your application build must
copy these assets; the mapper does not copy them. A Vite build can instead compile SQL into the application bundle.

## Build for Workers and other bundled runtimes

Use the [Wrangler custom build](../integrations/workers.md) or an explicit
[bundler adapter](../integrations/bundlers.md) when the deployed runtime cannot load configuration
or SQL assets. Import the grammar's portable query entrypoint in runtime modules and keep the
build integration in build configuration. Bundles contain static SQL and checked value plans;
configuration and snapshots remain build inputs.

Each SQL module exports `valuePlan`; its `typePolicyHash` can configure a matching
[portable adapter profile](../reference/portable-adapters.md). For inline queries, use
`getQueryValuePlan(query)` from `@typed-sql/core`.

The adapters support bounded conditional fragments and grammar-proven repeated fragments.
Result-dependent structures remain conservative when the compiler cannot prove an exact
contract. Empty or changed fragment structures fail closed. Build transforms do not replace
application typechecking: use `typed-sql check` for inline inference, plus generated SQL
file declarations or the experimental content mapper for imported assets.

## Editor and tooling boundaries

TypeScript 7.1's official editor integration runs configured content mappers in trusted workspaces
after mapper permissions are granted. Enable the TypeScript 7 integration and use the beta SDK;
see Microsoft's [content mapper announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers).
The same mapper reports SQL diagnostics and supplies the imported factory's TypeScript type.
The typed-sql SDK proxy preserves the official client's external-code execution permission. Without that permission, mapped imports remain unavailable; the proxy does not enable
external execution by default. SQL completion, rename, and definition mapping are not provided by
this frontend.

The stable `typed-sql check`, `generate`, and manifest commands discover inline TypeScript SQL
templates. They **do not analyze the source of `.sql` imports**. Generate declarations with
`typed-sql-build types` before ordinary checking, or use `tsc --runExternalCode` for live
asset checking through the experimental mapper. SQL-file statements are absent from generated query
manifests and their live-verification, plan, and compatibility reports. Keep queries inline when
those artifact workflows are required.
