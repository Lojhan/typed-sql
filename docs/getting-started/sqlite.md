---
title: SQLite quickstart
description: Create a strict SQLite table, generate schema evidence, check an exact query contract, and execute it through Node's built-in SQLite driver.
pageType: tutorial
---

# SQLite quickstart

This path creates a local SQLite database and takes one query through schema generation, checking,
and execution. It uses the stable SQLite grammar and the optional adapter for Node's built-in driver;
no database server or third-party driver is required.

## 1. Check the prerequisites

Use Node.js 22.13 or newer for the built-in `node:sqlite` adapter and TypeScript 7.0.2. The SQLite
grammar supports library versions 3.39.0–3.53.4 and treats unknown newer libraries conservatively.
Review [SQLite compatibility](../dialects/sqlite.md#supported-versions) for exact evidence.

The quickstart stores its scoped development database at `app.db`.

Start an empty ESM project:

```sh
mkdir typed-sql-sqlite && cd typed-sql-sqlite
pnpm init
pnpm pkg set type=module
mkdir src
```

## 2. Install the packages

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript tsx
```

`node:sqlite` is built into supported Node versions. Installing `@typed-sql/sqlite` does not select
or load it until the explicit adapter entrypoint is used.

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
import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync("app.db");

try {
  database.exec(`
    CREATE TABLE account (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
    ) STRICT;
    INSERT INTO account (id, email, status)
    VALUES (1, 'ada@example.com', 'active');
  `);
} finally {
  database.close();
}
```

Run it once:

```sh
pnpm exec tsx src/setup.ts
```

## 4. Create a minimal config

Create `typed-sql.config.ts`:

```ts
import { defineConfig } from "@typed-sql/core";
import { sqlite, typePolicy } from "@typed-sql/sqlite";
import { nodeSqlite } from "@typed-sql/sqlite/node-sqlite";

const path = "app.db";

export default defineConfig({
  dialect: sqlite({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: nodeSqlite({ path, typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

The same `typePolicy` controls PRAGMA introspection, compile-time inference, and adapter decoding.

## 5. Generate the snapshot

```sh
pnpm exec typed-sql generate
```

This reads SQLite metadata and writes deterministic compiler input under `generated/db`. Commit the
snapshot so schema changes are reviewable; application code does not import it.

## 6. Write one parameterized query

Create `src/account.ts`:

<!-- docs:start quickstart-sqlite-query -->
```ts
import { sql } from "@typed-sql/sqlite";

export const accountById = (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM account
  WHERE account.id = ${accountId}
`;
```
<!-- docs:end quickstart-sqlite-query -->

`accountId` remains a value segment and renders as `?`.

## 7. Check the inferred contract

```sh
pnpm exec typed-sql check --project tsconfig.json
```

Against the strict table above, the compiler proves:

<!-- docs:start quickstart-sqlite-contract -->
```ts
type AccountByIdQuery = Query<
  { "id": bigint; "email": string; "status": string; },
  readonly [bigint]
>;
```
<!-- docs:end quickstart-sqlite-contract -->

SQLite does not derive a string-literal union from this `CHECK` constraint, so `status` remains
`string`. The stable check is authoritative; [compiler and editor workflow](./compiler-and-editor.md)
explains the conservative declaration shown by an ordinary TypeScript server.

## 8. Execute the query

Create `src/run.ts`:

```ts
import { typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";
import { accountById } from "./account.js";

const database = await createNodeSqliteDatabase({ path: "app.db", typePolicy });

try {
  console.log(await database.maybeOne(accountById(1n)));
} finally {
  await database.close();
}
```

```sh
pnpm exec tsx src/run.ts
```

The adapter is explicit. Another SQLite integration can implement the driver-neutral runtime
contract without changing the grammar.

## 9. Confirm a type error

Temporarily interpolate a string directly in the `INTEGER` comparison:

```ts
const wrongId = "1";

sql`SELECT id FROM account WHERE id = ${wrongId}`;
```

Run `typed-sql check` again. The transformed check reports that `string` is not assignable to the
`bigint` parameter position. Restore the valid query before continuing.

## 10. Choose the next step

- Review the [driver and adapter boundary](../guides/adapters.md).
- Add the [experimental editor tooling](../guides/editors.md) only after the CLI path works.
- Explore the [complete SQLite application](../examples/sqlite.md).
- Add [production controls](../operations/index.md) independently when the application needs them.

## What just happened?

- The SQLite grammar—not the neutral compiler—owned SQL syntax, dynamic typing rules, placeholders, and diagnostics.
- The generated snapshot supplied PRAGMA and library evidence without becoming an application API.
- `typed-sql check` proved the row and ordered parameter tuple and remains the authoritative result.
- The interpolated id stayed a driver parameter instead of becoming SQL text.
- The shared type policy kept inferred types and runtime decoding aligned; no runtime validation was implied.
- The application selected and closed `node:sqlite`; typed-sql did not hide connection lifecycle.
