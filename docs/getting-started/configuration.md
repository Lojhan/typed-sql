---
title: Configuration
description: Connect a typed-sql dialect, schema provider, generated snapshot, and TypeScript project.
---

# Configuration

Create `typed-sql.config.ts` in the application root. The config selects the dialect, schema provider, generated output, TypeScript projects, and type policy used by both inference and runtime decoding.

## PostgreSQL

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: pg({
      connectionString: () => process.env.DATABASE_URL!,
      schemas: ["public"],
      typePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: {
    maxStructuralVariants: 64,
  },
});
```

## MySQL

```ts
import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { mysql2 } from "@typed-sql/mysql/mysql2";

export default defineConfig({
  dialect: mysql({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: mysql2({
      connectionUri: () => process.env.DATABASE_URL!,
      schemas: ["app"],
      typePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: {
    maxStructuralVariants: 64,
  },
});
```

## Generate and check

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
```

`generate` introspects the configured database and writes deterministic schema metadata. `check` analyzes SQL and asks TypeScript to validate the inferred overlay. `drift` compares the committed snapshot and type-policy hash with the live database.

Connection strings stay in the config callback or environment. They are not written to generated files. Commit the generated snapshot so schema and type-policy changes are reviewable.

The same `typePolicy` must be passed to the dialect, schema provider, and runtime adapter. This keeps the inferred TypeScript type aligned with the value returned by the driver.
