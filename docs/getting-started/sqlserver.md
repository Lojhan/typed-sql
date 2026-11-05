---
title: SQL Server quickstart
pageType: tutorial
description: Create a SQL Server commerce schema, generate native evidence, check a query, and execute checked plans with an application-owned ODBC driver.
---

# SQL Server quickstart

This tutorial uses the stable grammar, compiler and Node integration. Application code imports
`sql` from the grammar and keeps generated schema files as compiler inputs.

## 1. Prepare the connection

Use Node.js 24.11.1 or newer on Linux x64, unixODBC, Microsoft ODBC Driver 18, and a boxed SQL Server 2017–2025 database.
Create an empty database named `app` and use a login with schema creation and `VIEW DEFINITION`
permissions. [Compatibility](../dialects/sqlserver.md#compatibility) distinguishes supported
families from exact tested builds.

Set your connection string:

```sh
export SQLSERVER_CONNECTION_STRING='Driver={ODBC Driver 18 for SQL Server};Server=localhost,1433;Database=app;UID=app;PWD=your-password;Encrypt=yes;TrustServerCertificate=yes;'
```

## 2. Install the application dependencies

```sh
mkdir typed-sql-sqlserver && cd typed-sql-sqlserver
pnpm init
pnpm pkg set type=module
pnpm add @typed-sql/core @typed-sql/sqlserver koffi
pnpm add -D @typed-sql/cli @typed-sql/build esbuild typescript @types/node
mkdir src
```

The native SDK belongs to your application. Installing the grammar does not install a driver.
Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2024",
    "strict": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "typed-sql.config.ts"]
}
```

## 3. Create the commerce schema

Save this fixture as `schema.sql`:

<<< ../../examples/sqlserver/schema/001-schema.sql

Create `src/setup.ts`:

```ts
import { readFile } from "node:fs/promises";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

const connection = await createSqlServerOdbcDatabase({
  connectionString: process.env.SQLSERVER_CONNECTION_STRING!,
});
try {
  await connection.queryable.all(await readFile("schema.sql", "utf8"));
} finally {
  await connection.close();
}
```

```sh
node src/setup.ts
```

## 4. Select the grammar and shared policy

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { sqlserver, typePolicy } from "@typed-sql/sqlserver";
import { sqlServerOdbc } from "@typed-sql/sqlserver/odbc";

export default defineConfig({
  dialect: sqlserver({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: sqlServerOdbc({
      connectionString: () => process.env.SQLSERVER_CONNECTION_STRING!,
      includeSchemas: ["dbo"],
      typePolicy,
    }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

The provider and runtime establish the same canonical session settings on connections they own.
The snapshot records the actual product, engine, compatibility level, collation and native types.

## 5. Generate the compiler inputs

```sh
pnpm exec typed-sql generate
```

Commit `generated/db` so schema changes are reviewable. Application code does not import it.

## 6. Write the query

Create `src/account.ts`:

<!-- docs:start quickstart-sqlserver-query -->
```ts
import { sql } from "@typed-sql/sqlserver";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM dbo.users AS account
  WHERE account.id = ${accountId}
`;
```
<!-- docs:end quickstart-sqlserver-query -->

Values become parameters. The native adapter owns positional ODBC conversion and binding.

## 7. Check the inferred contract

```sh
pnpm exec typed-sql check --project tsconfig.json --show-types
```

The checked contract is:

<!-- docs:start quickstart-sqlserver-contract -->
```ts
type AccountByIdQuery = Query<
  { "id": bigint; "email": string; "status": string; },
  readonly [bigint]
>;
```
<!-- docs:end quickstart-sqlserver-contract -->

The stable CLI check is authoritative. An ordinary TypeScript server can show the conservative
published `Query<unknown>` declaration; [compiler and editor workflow](./compiler-and-editor.md)
explains the distinction.

## 8. Execute the checked query

Create `src/run.ts`:

```ts
import { typePolicy } from "@typed-sql/sqlserver";
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";
import { accountById } from "./account.js";

const database = await createSqlServerOdbcDatabase({
  connectionString: () => process.env.SQLSERVER_CONNECTION_STRING!,
  typePolicy,
});
try {
  console.log(await database.maybeOne(accountById(1n)));
} finally {
  await database.close();
}
```

Create `build.mjs` so inline templates receive checked execution plans:

```js
import { build } from "esbuild";
import { typedSql } from "@typed-sql/build/esbuild";

await build({
  entryPoints: ["src/run.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile: "dist/run.mjs",
  plugins: [typedSql()],
});
```

```sh
node build.mjs
node dist/run.mjs
```

The stable build integration validates source and attaches checked native value plans. Dependencies
stay external, including the application-owned native SDK. A plain TypeScript execution command
does not compile SQL or supply missing physical target evidence. The Node preload compiles SQL
file imports; inline templates use this build adapter.

## 9. Verify the error boundary

Replace the bigint argument with a string interpolation:

```ts
const wrongId = "1";
sql`SELECT id FROM dbo.users WHERE id = ${wrongId}`;
```

Run `typed-sql check` again. The checker reports the mismatched bigint parameter position.
Restore the valid query before running the application.

## 10. Add native features

Follow the [SQL Server examples](../examples/sqlserver.md) for named SQL files, `APPLY`, multi-row
`OUTPUT`, exact decimals, transactions and streaming. Review [build integrations](../integrations/bundlers.md)
for deployment options and [execution](../guides/execution.md) for ownership and controls.
