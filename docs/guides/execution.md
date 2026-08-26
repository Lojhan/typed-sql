---
title: Execute queries
description: Execute, prepare, and stream typed queries with application-owned PostgreSQL or MySQL drivers.
---

# Execute queries

The dialect root supplies the query type and renderer. A driver-specific adapter connects that contract to the driver owned by your application.

## Connect an adapter

### PostgreSQL

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

### MySQL

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

## Prepare repeated queries

`database.prepare(name, factory)` records a stable execution hint and returns a callable factory. Each call still produces an ordinary `Query`, so the result works with the same `execute()` and `stream()` methods as any other query.

```ts
const accountById = database.prepare("account-by-id", (accountId: bigint) => sql`
  SELECT account.id, account.email, account.status
  FROM accounts AS account
  WHERE account.id = ${accountId}
`);

const query = accountById(42n);
const rows = await database.execute(query);
```

The factory exposes its readonly `statementName`. A name must be non-empty, contain no NUL character, and be unique within one database instance. The first factory call records the rendered SQL text. Later calls may provide different parameter values, but they must render the same SQL text or typed-sql fails before driver dispatch.

Preparation is lazy: declaring the factory performs no I/O and checks out no connection. PostgreSQL uses the name for ordinary buffered execution. MySQL delegates execution to mysql2's per-connection prepared-statement cache.

## Stream large result sets

`database.stream(query, options?)` returns a lazy `QueryStream<Row>`. Creating it renders the query but does not acquire a connection. The first `next()` call or `for await` iteration starts driver work.

```ts
const accounts = database.stream(
  sql`
    SELECT account.id, account.email, account.status
    FROM accounts AS account
    ORDER BY account.id
  `,
  { batchSize: 500 },
);

for await (const account of accounts) {
  await indexAccount(account);

  if (shouldStop(account)) break;
}
```

The row retains the query's exact inferred type. `batchSize` must be a positive safe integer and expresses a preferred row count, not a byte limit. Its native meaning depends on the adapter: PostgreSQL fetches bounded cursor pages, while MySQL uses it as the protocol stream's object-mode high-water mark.

Natural completion, `break`, explicit `close()`, and async disposal finish the native stream and release a root-level connection exactly once. `close()` is idempotent. For manual iteration, close in a `finally` block:

```ts
const accounts = database.stream(query);

try {
  const first = await accounts.next();
  if (!first.done) await indexAccount(first.value);
} finally {
  await accounts.close();
}
```

`QueryStream` also implements `AsyncDisposable`, so runtimes that support explicit resource management can use `await using`.

PostgreSQL streaming requires the application-owned `pg-cursor` package in addition to `pg`. It is loaded only when iteration begins. MySQL streaming uses mysql2 itself and needs no additional package. See the [PostgreSQL](../dialects/postgresql.md#streaming) and [MySQL](../dialects/mysql.md#streaming) adapter details.

## Use capabilities inside transactions

Transaction callbacks receive the selected adapter's transaction type, so `execute()`, `prepare()`, and `stream()` remain available:

```ts
const changedAccount = database.prepare("changed-account", (accountId: bigint) => sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${accountId}
`);

await database.transaction(async (transaction) => {
  const stream = transaction.stream(changedAccount(42n));

  try {
    for await (const account of stream) {
      await indexAccount(account);
    }
  } finally {
    await stream.close();
  }
});
```

Declare reusable prepared factories once from the root database during application bootstrap. Prepared names remain reserved for that database instance, so declaring the same name inside a repeatedly called transaction callback would collide after its first invocation. The ordinary queries returned by a root factory retain their prepared metadata when executed or streamed through that database's transaction scopes.

A transaction stream must complete or close before its callback returns. It cannot escape the callback for later iteration. While a transaction stream is active, the same connection cannot execute another query, start another stream, or enter a nested transaction. If the callback returns with an open stream, the adapter closes it, reports the misuse, and rolls back instead of committing.

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
