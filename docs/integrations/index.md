---
title: Build and test integrations
description: Compile SQL modules and inline query plans with application-owned build tools and test runners.
pageType: tutorial
---

# Build and test integrations

`@typed-sql/build` connects your build tool or test runner to the stable typed-sql compiler.
One package provides separate entrypoints for each host. Install only the host you use;
the package does not install a bundler, test runner, database driver, or experimental editor backend.

The adapters compile `.sql` imports into query factories and attach execution plans to inline
TypeScript `sql` templates. They read your saved schema snapshot and executable configuration;
they never call the schema provider or connect to a database. SQL errors stop compilation.

## Prepare the application

Complete the [PostgreSQL](../getting-started/postgresql.md),
[MySQL](../getting-started/mysql.md), or [SQLite](../getting-started/sqlite.md) quickstart first.
Keep its grammar, driver, configuration, snapshot, and runtime type policy. Then install:

```sh
pnpm add -D @typed-sql/build
```

The host integrations run during development, testing, or compilation. A bundled deployment
contains the compiled queries and grammar runtime, so it does not need to load your configuration
or snapshot. Keep database access in server code when building a full-stack application.

## Import a SQL file

The PostgreSQL quickstart creates a `users` table with a text `email` column. Create
`src/find-user.sql`:

```sql
SELECT email FROM users WHERE email = $1
```

For MySQL, use `?` in place of `$1`. The SQLite quickstart names its table `account`, so use:

```sql
SELECT email FROM account WHERE email = ?
```

Each file contains one statement. Positional parameters must appear once in order; use inline
composition for dynamic SQL structure.

```ts
import findUser from "./find-user.sql";

const user = await database.maybeOne(findUser("ada@example.com"));
```

Generate declarations before checking the application:

```sh
pnpm exec typed-sql-build types
pnpm exec typed-sql check
```

Enable arbitrary extension declarations in your existing `tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "allowArbitraryExtensions": true
  }
}
```

Ordinary TypeScript also consumes these declarations; inline SQL result inference uses
`typed-sql check`. `typed-sql-build types` writes `src/find-user.d.sql.ts` beside the SQL source. These declarations contain
the inferred row and ordered parameter tuple. Regenerate after changing SQL, configuration,
type policy, or schema. Ordinary TypeScript reads the generated declarations; it does not
revalidate the SQL source itself. Check committed declarations without changing files in CI:

```sh
pnpm exec typed-sql-build types --check
```

Generation removes only its own obsolete declarations. It refuses to replace handwritten files.
Keep the generated declarations in version control, or generate them before every typecheck.
No TypeScript beta or content mapper is required for this workflow.

## Check inline queries

Application code continues to import `sql` from the selected grammar:

```ts
import { sql } from "@typed-sql/postgres";

export const findUser = (email: string) =>
  sql`SELECT email FROM users WHERE email = ${email}`;
```

The build adapter validates SQL and attaches runtime metadata. It does not replace the
[typed-sql typechecking workflow](../getting-started/compiler-and-editor.md): run
`typed-sql check` to check downstream TypeScript uses of inferred inline results. A host's
ordinary TypeScript checker cannot infer inline SQL by itself.

## Choose a host

| Host | Integration |
| --- | --- |
| Vite and Vitest | [Vite plugin](./vite.md) |
| Astro, Nuxt, SvelteKit | [Framework server builds](./frameworks.md) |
| Wrangler and D1 | [Worker custom build](./workers.md) |
| Next.js | [Turbopack and webpack](./next.md) |
| Bun build, runtime, and tests | [Bun plugin and preload](./bun.md) |
| Jest | [Transformer and existing-transformer composition](./jest.md) |
| webpack, Rspack, Rsbuild, esbuild, Rollup, Rolldown | [Bundler adapters](./bundlers.md) |
| Node test runner, Mocha, AVA, Poku | [Node preload](./node.md) |

## Configure a project

Build plugin and transformer factories accept `cwd` and `config`. `cwd` selects the application directory; `config` selects
a configuration file relative to it. Without an explicit file, normal typed-sql configuration
discovery applies. Monorepos should select the application explicitly.

`inline: false` limits compilation to `.sql` modules. `include` and `exclude` accept arrays of
glob patterns relative to `cwd`. Defaults cover `.sql`, `.ts`, `.tsx`, `.mts`, and `.cts`, excluding
dependencies, declaration files, and common output directories. Bundler imports with a query suffix,
such as `?raw`, are left to the host. Components should import query functions from TypeScript
modules; the adapters do not parse `.vue`, `.svelte`, or `.astro` component syntax.

Build caches include the source, compiler package version, snapshot, type policy, configuration,
and imported local configuration dependencies. `cacheSize` bounds retained modules, with a
separate 32 MiB ceiling. `timeoutMs` bounds synchronous Jest requests. Configuration executes
application-owned code, so use configurations you trust.
