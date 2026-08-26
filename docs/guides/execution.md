---
title: Execute queries
description: Execute typed queries with an application-owned pg or mysql2 driver and matching runtime codecs.
---

# Execute queries

The dialect root supplies the query type and renderer. A driver-specific adapter connects that contract to the driver owned by your application.

## PostgreSQL

```ts
import { sql, typePolicy } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  typePolicy,
});

try {
  const query = sql`
    SELECT account.id, account.email
    FROM accounts AS account
    ORDER BY account.id
  `;

  const rows = await database.execute(query);
} finally {
  await database.close();
}
```

## MySQL

```ts
import { sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
  typePolicy,
});

try {
  const query = sql`
    SELECT account.id, account.email
    FROM accounts AS account
    ORDER BY account.id
  `;

  const rows = await database.execute(query);
} finally {
  await database.close();
}
```

`database.execute(query)` returns `Promise<readonly Row[]>`, where `Row` is the type inferred for the complete statement. Command statements without a result surface use `never` as their row type.

## Parameters and identifiers

Ordinary interpolations become driver parameters:

```ts
const query = sql`
  SELECT account.id
  FROM accounts AS account
  WHERE account.id = ${accountId}
`;
```

Identifiers are SQL structure and must be explicit:

```ts
const query = sql`
  SELECT ${sql.ident("display_name")}
  FROM accounts
`;
```

`sql.ident()` delegates quoting to the selected dialect. `sql.raw()` inserts trusted static SQL without escaping and must never receive untrusted input.

## Keep type policy aligned

The type policy used for generation must also be passed to the runtime adapter. A mismatch can make a correct static type disagree with the JavaScript value returned by the driver. See [Database type mappings](../reference/type-mappings.md).

Static query types do not validate data from an external trust boundary. Validate request payloads, untrusted database content, and serialized responses at runtime when your application requires it.
