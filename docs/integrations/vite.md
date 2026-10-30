---
title: Vite and Vitest
description: Install the typed-sql Vite plugin for SQL file imports and compiled inline queries, including Vitest workers.
pageType: tutorial
---

# Vite and Vitest

Complete the [shared setup](./index.md), then install your host:

```sh
pnpm add -D @typed-sql/build vite
```

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import { typedSql } from "@typed-sql/build/vite";

export default defineConfig({
  plugins: [typedSql()],
});
```

The plugin runs before TypeScript transpilation. It compiles `.sql` imports and attaches runtime
plans to inline queries in TypeScript modules. Vite handles module resolution and transpilation.
Keep database queries in the server build; the plugin does not turn database drivers into
browser-compatible modules.

```sh
pnpm exec typed-sql-build types
pnpm exec typed-sql check
pnpm exec vite build
```

Vite observes the snapshot, configuration, and imported local configuration modules. Changes
invalidate compiled query modules; development sends a full reload when those inputs change.
Invalid SQL fails the transform with its original file location.

## Vitest

Vitest uses the same plugin:

```sh
pnpm add -D vitest
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { typedSql } from "@typed-sql/build/vite";

export default defineConfig({
  plugins: [typedSql()],
  test: { environment: "node" },
});
```

```ts
import { expect, test } from "vitest";
import findUser from "./find-user.sql";
import { database } from "./database.ts";

test("finds a user", async () => {
  const rows = await database.all(findUser("ada@example.com"));
  expect(rows).toHaveLength(1);
});
```

Provide your own test database and cleanup, as in a normal driver test. The compiler reads the
saved snapshot; database creation and migrations remain application responsibilities.

```sh
pnpm exec vitest run
pnpm exec vitest
```

Fork and thread pools use the same adapter. Vitest execution does not replace `typed-sql check`.

## Compatibility

The supported Vite range is `>=6.4.5 <9`. Packed-consumer tests exercise Vite 6.4.5 and 8.3.5,
and Vitest 5.0.5 with both fork and thread pools. These are exact tested versions, rather than
an exhaustive list of every supported patch. Use the Node.js version required by your host.
