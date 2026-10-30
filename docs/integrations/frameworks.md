---
title: Astro, Nuxt, and SvelteKit
description: Add typed-sql to framework server builds with verified Vite and Nitro configurations.
pageType: tutorial
---

# Astro, Nuxt, and SvelteKit

Complete the [shared setup](./index.md). Put inline query functions in `.ts` modules, then import
those modules from components or server routes. The adapters compile TypeScript query modules
and SQL files; they do not parse SQL templates embedded directly in component syntax.

Generate SQL declarations before running the framework's existing typecheck and build scripts.
SQL-file imports use ordinary TypeScript declarations, including with frameworks using TypeScript
6.0.3. Inferred inline query consumers in `.ts` modules use `typed-sql check`, which requires the
supported TypeScript 7 compiler. Use the framework's own checker for component syntax.

Keep driver imports and database connections on the server. Existing framework configuration,
adapters, and component plugins remain application-owned.

## Astro

In an existing Astro application:

```sh
pnpm add -D @typed-sql/build
```

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import { typedSql } from "@typed-sql/build/vite";

export default defineConfig({
  vite: { plugins: [typedSql()] },
});
```

An Astro page can import a query from its server-side frontmatter:

```astro
---
import findUser from "../queries/find-user.sql";
import { database } from "../database";
const user = await database.maybeOne(findUser("ada@example.com"));
---
<p>{user?.email}</p>
```

```sh
pnpm exec typed-sql-build types
pnpm exec astro build
```

Static pages execute database work at build time; server-rendered pages execute it at request
time through your chosen Astro adapter. Query analysis itself reads the offline snapshot.

## Nuxt

Nuxt's application Vite graph and Nitro server build need separate registrations:

```sh
pnpm add -D @typed-sql/build esbuild
```

```ts
// nuxt.config.ts
import { defineNuxtConfig } from "nuxt/config";
import { typedSql as viteSql } from "@typed-sql/build/vite";
import { typedSql as serverSql } from "@typed-sql/build/rollup";

export default defineNuxtConfig({
  vite: { plugins: [viteSql({ cwd: process.cwd() })] },
  nitro: {
    hooks: {
      "rollup:before"(_nitro, config) {
        config.plugins.unshift(serverSql({ cwd: process.cwd() }));
      },
    },
  },
});
```

Nitro has a built-in raw-text loader for SQL files. Prepending the adapter through
`rollup:before` lets typed-sql resolve and compile SQL before that loader claims it.
Adding the plugin only to `nitro.rollupConfig.plugins` places it too late for this path.

```ts
// server/api/users.get.ts
import findUser from "../queries/find-user.sql";
import { database } from "../database";

export default defineEventHandler(async () => {
  return database.maybeOne(findUser("ada@example.com"));
});
```

```sh
pnpm exec typed-sql-build types
pnpm exec nuxt build
```

Run the framework's own component and application checks as well. Plain typed-sql checking of
query modules does not replace Vue component checking.

## SvelteKit

In a SvelteKit 3 application using its Node adapter:

```sh
pnpm add -D @typed-sql/build @sveltejs/adapter-node
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-node";
import { typedSql } from "@typed-sql/build/vite";

export default defineConfig({
  plugins: [typedSql(), sveltekit({ adapter: adapter() })],
});
```

SvelteKit 3 takes this configuration through `sveltekit(...)`; it rejects a separate
`svelte.config.js`. On a SvelteKit version that uses a separate configuration file, retain
that version's framework configuration and add only `typedSql()` to Vite.

```ts
// src/routes/api/users/+server.ts
import findUser from "$lib/server/find-user.sql";
import { database } from "$lib/server/database";

export async function GET() {
  return Response.json(await database.maybeOne(findUser("ada@example.com")));
}
```

```sh
pnpm exec typed-sql-build types
pnpm exec vite build
```

Keep SvelteKit's component checks in your normal validation script. Inferred inline query use
inside Svelte component syntax is outside this adapter's TypeScript-module transform.

## Tested recipes

Packed-consumer tests exercise Astro 7.4.4 with a static server-side page, Nuxt 4.6.3 with a
Nitro server endpoint, and SvelteKit 3.1.1 with `@sveltejs/adapter-node` 6.0.1. They compile both
SQL files and inline query modules and execute real SQLite queries. SQL declaration consumption and incorrect-argument rejection
are also checked with TypeScript 6.0.3. Nuxt and SvelteKit tests
start the production servers and verify HTTP responses. Use the Node.js version required by
the selected framework; the shared package minimum does not override host requirements.
