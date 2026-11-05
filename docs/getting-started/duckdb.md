---
title: DuckDB quickstart
pageType: tutorial
description: Create a DuckDB file, generate catalog evidence, compile a named SQL query, and execute it with the official application-owned Node SDK.
---

# DuckDB quickstart

This tutorial uses SQL file imports and the stable Node preload, so execution receives the compiled
value plans required by the DuckDB adapter. Use Node.js 24.11.1 or newer for this preload workflow.
See the [compatibility table](../dialects/duckdb.md#engine-and-driver-compatibility) for the exact
qualified engine/SDK pairs.

## Install an ESM application

```sh
mkdir typed-sql-duckdb && cd typed-sql-duckdb
pnpm init
pnpm pkg set type=module
pnpm add @typed-sql/core @typed-sql/duckdb @typed-sql/build @duckdb/node-api
pnpm add -D @typed-sql/cli typescript @types/node
mkdir src
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2024",
    "strict": true,
    "noEmit": true,
    "allowArbitraryExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "typed-sql.config.ts"]
}
```

## Create the database

Create `src/setup.ts`. This setup uses the application's SDK directly:

```ts
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create("app.duckdb");
try {
  const connection = await instance.connect();
  try {
    for (const statement of [
      `CREATE TABLE users (
        id BIGINT PRIMARY KEY,
        email VARCHAR NOT NULL,
        profile STRUCT("displayName" VARCHAR, tags VARCHAR[]) NOT NULL
      )`,
      `INSERT INTO users VALUES
        (1, 'ada@example.com', {'displayName':'Ada','tags':['analytics','sql']})`,
    ]) {
      const result = await connection.run(statement);
      result.closeSync();
    }
  } finally {
    connection.closeSync();
  }
} finally {
  instance.closeSync();
}
```

Run setup once against a new file:

```sh
node src/setup.ts
```

## Configure the grammar and snapshot

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { duckdb, typePolicy } from "@typed-sql/duckdb";
import { nodeDuckDB } from "@typed-sql/duckdb/node-api";

export default defineConfig({
  dialect: duckdb({ typePolicy }),
  typePolicy,
  schema: {
    file: "generated/db/schema.json",
    provider: nodeDuckDB({ path: "app.duckdb", typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
});
```

```sh
pnpm exec typed-sql generate
```

Commit the generated snapshot as reviewable compiler input. Application code does not import it.
Use the same policy for introspection, compilation and execution.

## Compile a named SQL file

Create `src/find-user.sql`:

```sql
SELECT id, email, profile
FROM users
WHERE id = :id
```

Create `src/run.ts`:

```ts
import { createNodeDuckDBDatabase } from "@typed-sql/duckdb/node-api";
import findUser from "./find-user.sql";

const database = await createNodeDuckDBDatabase({ path: "app.duckdb" });
try {
  const user = await database.maybeOne(findUser({ id: 1n }));
  console.log(user?.profile.displayName);
} finally {
  await database.close();
}
```

Generate co-located declarations and check:

```sh
pnpm exec typed-sql-build types
pnpm exec typed-sql check --project tsconfig.json --show-types
```

The input is `{ id: bigint }`. The row contains `id: bigint`, `email: string`, and a required
`profile` object with nullable `displayName` and `tags` fields; LIST elements are nullable too.
Replacing the input with `{ id: "1" }` produces a TypeScript parameter error.

Named SQL files accept `:id` or `$id`, including repeated names. A positional file can instead use
`$1` and be called as `findUser(1n)`. Values render as native `$N` parameters.

## Execute the compiled query

```sh
node --import=@typed-sql/build/register src/run.ts
```

The preload compiles the SQL import and attaches its checked runtime value plan. It does not
transform inline TypeScript templates. Use a [build adapter](../integrations/index.md) when compiling
inline queries for application execution.

Continue with [nested and analytical queries](../examples/duckdb.md),
[SQL file imports](../guides/sql-files.md), or the [DuckDB reference](../dialects/duckdb.md).
