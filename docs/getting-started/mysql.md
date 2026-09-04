---
title: MySQL quickstart
description: Create a MySQL table, generate schema evidence, check an exact query contract, and execute it through an application-owned mysql2 driver.
pageType: tutorial
---

# MySQL quickstart

This path takes a small MySQL application from an existing database connection to one checked and
executed query. The grammar and compiler are stable; the optional editor integration is not part of
this path.

## 1. Check the prerequisites

Use Node.js 22.11 or newer, TypeScript 7.0.2, and a MySQL 8.4 or 9.7 LTS database. Review
[MySQL compatibility](../dialects/mysql.md#version-support-and-differential-evidence) for exact tested targets and SQL-mode
boundaries.

Create an empty database named `app`, then set its connection URI:

```sh
export DATABASE_URL=mysql://user:password@127.0.0.1:3306/app
```

The database and its lifecycle remain yours.

Start an empty ESM project:

```sh
mkdir typed-sql-mysql && cd typed-sql-mysql
pnpm init
pnpm pkg set type=module
mkdir src
```

## 2. Install the packages

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript tsx
```

`mysql2` is an explicit application dependency. Installing `@typed-sql/mysql` does not install it.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2024",
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "typed-sql.config.ts"]
}
```

## 3. Create a minimal table

Create `src/setup.ts`:

```ts
import { createConnection } from "mysql2/promise";

const connection = await createConnection(process.env.DATABASE_URL!);

try {
  await connection.query(`
    CREATE TABLE users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      status ENUM('active', 'suspended') NOT NULL DEFAULT 'active'
    )
  `);
  await connection.query("INSERT INTO users (email) VALUES (?)", ["ada@example.com"]);
} finally {
  await connection.end();
}
```

Run it once against the empty database:

```sh
pnpm exec tsx src/setup.ts
```

## 4. Create a minimal config

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { mysql2 } from "@typed-sql/mysql/mysql2";

const connectionUri = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: mysql({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: mysql2({ connectionUri, schemas: ["app"], typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

The same `typePolicy` controls introspection, compile-time inference, and adapter decoding.

## 5. Generate the snapshot

```sh
pnpm exec typed-sql generate
```

This introspects MySQL and writes deterministic compiler input under `generated/db`. Commit the
snapshot so schema changes are reviewable; application code does not import it.

## 6. Write one parameterized query

Create `src/account.ts`:

<LiveQueryExample dialect="mysql" filename="src/account.ts">
<template #source>

<!-- docs:start quickstart-mysql-query -->
```ts
import { sql } from "@typed-sql/mysql";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM users AS account
  WHERE account.id = ${accountId}
`;
```
<!-- docs:end quickstart-mysql-query -->

</template>
</LiveQueryExample>

`accountId` remains a value segment and renders as `?`.

## 7. Check the inferred contract

```sh
pnpm exec typed-sql check --project tsconfig.json
```

Against the table above, the compiler proves:

<!-- docs:start quickstart-mysql-contract -->
```ts
type AccountByIdQuery = Query<
  { "id": bigint; "email": string; "status": "active" | "suspended"; },
  readonly [bigint]
>;
```
<!-- docs:end quickstart-mysql-contract -->

The stable check is authoritative. An ordinary TypeScript server can still show the conservative
published `Query<unknown>` declaration; [compiler and editor workflow](./compiler-and-editor.md)
explains why.

## 8. Execute the query

Create `src/run.ts`:

```ts
import { typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";
import { accountById } from "./account.js";

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
  typePolicy,
});

try {
  console.log(await database.maybeOne(accountById(1n)));
} finally {
  await database.close();
}
```

```sh
pnpm exec tsx src/run.ts
```

The adapter is optional. You can instead [render into an existing mysql2 pool](../guides/existing-pools.md).

## 9. Confirm a type error

Temporarily interpolate a string directly in the `BIGINT` comparison:

```ts
const wrongId = "1";

sql`SELECT id FROM users WHERE id = ${wrongId}`;
```

Run `typed-sql check` again. The transformed check reports that `string` is not assignable to the
`bigint` parameter position. Restore the valid query before continuing.

## 10. Choose the next step

- [Adopt an existing pool](../guides/existing-pools.md) without transferring ownership.
- Add the [experimental editor tooling](../guides/editors.md) only after the CLI path works.
- Explore the [complete MySQL application](../examples/mysql.md).
- Add [production controls](../operations/index.md) independently when the application needs them.

## What just happened?

- The MySQL grammar—not the neutral compiler—owned SQL syntax, enum inference, placeholders, modes, and diagnostics.
- The generated snapshot supplied schema evidence without becoming an application API.
- `typed-sql check` proved the row and ordered parameter tuple and remains the authoritative result.
- The interpolated id stayed a driver parameter instead of becoming SQL text.
- The shared type policy kept inferred types and runtime decoding aligned; no runtime validation was implied.
- The application installed and closed `mysql2`; typed-sql did not own the driver or connection lifecycle.
