---
title: Next.js
description: Compile typed-sql queries with Next.js Turbopack and webpack while retaining an explicit application typecheck gate.
pageType: tutorial
---

# Next.js

Complete the [shared setup](./index.md), keeping queries and database connections in server code.
Install the adapter and its TypeScript transpiler into an existing Next application:

```sh
pnpm add -D @typed-sql/build esbuild
```

Wrap your configuration:

```js
// next.config.mjs
import { withTypedSql } from "@typed-sql/build/next";

export default withTypedSql({
  // Keep your existing Next configuration here.
});
```

The helper installs Turbopack SQL and inline TypeScript rules and a webpack plugin. It preserves
the application's existing webpack callback. An existing Turbopack rule matching the same
extension causes an error instead of silently replacing that rule; compose the
`@typed-sql/build/webpack-loader` explicitly in that case.

## Typechecking

For SQL file imports, generate declarations and enable `allowArbitraryExtensions` as described
in the [shared setup](./index.md). The generated declarations work with the normal TypeScript
checker used by Next.

Inline SQL inference requires `typed-sql check`. The helper does not disable Next's typechecker.
If your application uses inferred inline result fields, replace Next's built-in typecheck with
an explicit prebuild gate:

```js
// next.config.mjs
import { withTypedSql } from "@typed-sql/build/next";

export default withTypedSql({
  typescript: { ignoreBuildErrors: true },
});
```

```json
{
  "scripts": {
    "check": "typed-sql-build types && next typegen && typed-sql check",
    "build": "pnpm check && next build"
  }
}
```

Keep the check and build chained with `&&`. Setting `ignoreBuildErrors` without the replacement
gate skips application typechecking. Include Next's generated type files in the application's
TypeScript project and keep the normal Next TypeScript options. The typed-sql checker reports
downstream TypeScript errors as well as SQL diagnostics.

## Server usage

Keep reusable inline query functions in `.ts` modules and import them from route handlers or
server components. SQL file imports return the same query objects:

```ts
// app/api/users/route.ts
import findUser from "../../../src/find-user.sql";
import { database } from "../../../src/database";

export const runtime = "nodejs";

export async function GET() {
  const user = await database.maybeOne(findUser("ada@example.com"));
  return Response.json(user);
}
```

Choose the Next runtime supported by your driver. Node drivers belong in Node routes; a Worker
or edge runtime needs a compatible explicit adapter. Never import a database connection into a
client component.

```sh
pnpm build
pnpm exec next build --webpack
```

When invoking `next build --webpack` directly, run the same prebuild check first. Both build
backends use the shared offline compiler; neither connects to the database during query analysis.

## Compatibility

The supported Next.js range is `>=16.4 <17`. Packed-consumer tests exercise Next.js 16.4.3
production builds with both Turbopack and webpack, start each production server, and execute
compiled queries through an HTTP route. They also verify that the explicit check gate rejects
an incorrect SQL parameter before building.
