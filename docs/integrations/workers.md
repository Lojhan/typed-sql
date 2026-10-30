---
title: Wrangler and D1
description: Compile typed-sql queries in a Wrangler custom build and execute them through a Worker D1 binding.
pageType: tutorial
---

# Wrangler and D1

Wrangler's internal bundler does not expose your application's esbuild plugin configuration.
Use a custom build to compile typed-sql before Wrangler packages the Worker.

This recipe assumes an existing Worker, D1 binding, and saved SQLite schema snapshot describing
the application's tables. Follow the [portable D1 adapter requirements](../reference/portable-adapters.md#d1),
including STRICT tables and an explicit `integer: "number"` type policy.

## Install

```sh
pnpm add @typed-sql/sqlite @typed-sql/adapters
pnpm add -D @typed-sql/build @typed-sql/cli esbuild wrangler typescript
```

The build tools load your executable configuration on Node. They do not ship into the Worker
and do not call a schema provider during compilation. Select the saved snapshot explicitly:

```ts
// typed-sql.config.ts
import { defineConfig } from "@typed-sql/core";
import { sqlite, typePolicy as defaults } from "@typed-sql/sqlite";

const typePolicy = { ...defaults, integer: "number" as const };

export default defineConfig({
  dialect: sqlite({ typePolicy }),
  typePolicy,
  schema: { file: "generated/db/schema.json" },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
});
```

Keep snapshot refresh and database migrations in the application's existing schema workflow.
The configuration above intentionally has no introspection provider; checking and bundling
consume the saved snapshot without a live connection.

## Configure the custom build

```js
// build.mjs
import { build } from "esbuild";
import { typedSql } from "@typed-sql/build/esbuild";

await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  sourcemap: true,
  plugins: [typedSql()],
});
```

Add the build to your existing Wrangler configuration, retaining your actual binding and ID:

```jsonc
// wrangler.jsonc
{
  "name": "my-worker",
  "main": "dist/worker.mjs",
  "compatibility_date": "2026-10-30",
  "build": {
    "command": "node build.mjs",
    "watch_dir": ["src", "typed-sql.config.ts", "generated/db/schema.json"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-database",
      "database_id": "YOUR_DATABASE_ID"
    }
  ]
}
```

Include locally imported configuration modules in `watch_dir` too. Wrangler's custom build
watcher is separate from esbuild's context watch API.

## Query the binding

With an `account` table containing a text `email` column, create `src/find-account.sql`:

```sql
SELECT email FROM account WHERE email = ?
```

```ts
// src/worker.ts
import { getQueryValuePlan } from "@typed-sql/core";
import { createD1Database, type D1Binding } from "@typed-sql/adapters/d1";
import { sqliteRenderer } from "@typed-sql/sqlite/query";
import findAccount from "./find-account.sql";

export default {
  async fetch(_request: Request, env: { DB: D1Binding }): Promise<Response> {
    const query = findAccount("ada@example.com");
    const plan = getQueryValuePlan(query);
    if (!plan) throw new Error("Compile this Worker with the typed-sql build plugin");

    const database = createD1Database(env.DB, {
      renderer: sqliteRenderer,
      profile: {
        id: "d1",
        dialect: "sqlite",
        integer: "safe-number",
        jsonWire: "text",
        typePolicyHash: plan.typePolicyHash,
      },
    });
    return Response.json(await database.all(query));
  },
};
```

The explicit profile describes D1's wire representation and must agree with the compiled
query's type policy. The portable grammar entrypoint avoids importing Node introspection or
driver modules into the Worker. Use the same selected policy for every query on this binding.

## Check and run locally

Enable `allowArbitraryExtensions` for SQL declarations in your TypeScript project, then run:

```sh
pnpm exec typed-sql-build types
pnpm exec typed-sql check
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler dev --local
```

Apply the application's migrations and seed data to the local D1 database before querying it.
Wrangler runs the custom build for development and deployment. Production artifacts contain
compiled query factories, with no runtime configuration or snapshot loading.

Packed-consumer tests exercise Wrangler 4.156.0's custom build and a local workerd D1 binding,
including SQL files, inline templates, repeated fragments, conditional projections, and invalid
SQL rejection. The tests do not deploy a Worker or use Cloudflare credentials.
