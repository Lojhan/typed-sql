---
title: Execute queries
description: Execute, prepare, and stream typed queries with application-owned PostgreSQL, MySQL, or SQLite adapters.
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

### SQLite preview

```ts
import { sql, typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";

const database = await createNodeSqliteDatabase({
  path: process.env.DATABASE_PATH ?? "app.db",
  typePolicy,
});

try {
  const rows = await database.execute(sql`
    SELECT account.id, account.email
    FROM account
    ORDER BY account.id
  `);
} finally {
  await database.close();
}
```

The built-in Node adapter is synchronous underneath its promise-shaped API. It advertises neither
cancellation nor deadlines. See the [SQLite dialect guide](../dialects/sqlite.md) for threading,
streaming, and dynamic-typing constraints.

`database.execute(query)` returns `Promise<readonly Row[]>`, where `Row` is the type inferred for the complete statement. Command statements without a result surface use `never` as their row type.

## Assert cardinality and control execution

Use `all`, `one`, or `maybeOne` when the calling code has an explicit row-count contract:

```ts
const controller = new AbortController();

const account = await database.maybeOne(accountByEmail, {
  signal: controller.signal,
  deadline: Date.now() + 2_000,
});
```

- `all(query, options?)` returns every row.
- `one(query, options?)` requires exactly one row.
- `maybeOne(query, options?)` accepts zero or one row.

All three retain the query's inferred row type. Cardinality is checked after the driver returns; typed-sql never changes the SQL by adding `LIMIT`. Failures are inspectable without parsing messages:

| Error | Code | Stable fields |
| --- | --- | --- |
| `QueryCardinalityError` | `TSQL_CARDINALITY` | `expected`, `actual` |
| `QueryCancelledError` | `TSQL_CANCELLED` | `reason` (`signal` or `deadline`) |
| `UnsupportedExecutionCapabilityError` | `TSQL_UNSUPPORTED_EXECUTION_CAPABILITY` | `capability` |

`deadline` is absolute, expressed as Unix milliseconds or a `Date`. A pre-aborted signal or expired deadline fails before leasing a connection. For an in-flight operation, the pg and mysql2 adapters interrupt conservatively by discarding the checked-out connection, then wait for driver settlement before rejecting. Inside a transaction, cancellation invalidates that transaction and discards its lease; do not catch the cancellation and continue using the scope.

Inspect `database.executionCapabilities` before accepting optional controls in adapter-generic infrastructure. The official `pg` and `mysql2` adapters advertise cancellation and deadlines. A custom adapter that cannot safely interrupt work reports the unsupported capability immediately. `execute(query)` and `all(query)` without controls retain the existing thin buffered path.

Execution options intentionally do not alter `batch()`, PostgreSQL `pipeline()`, or `stream()`. Those APIs own multiple operations or a longer-lived resource and keep their documented cleanup semantics.

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

The factory exposes its readonly `statementName`. A name must be non-empty, contain no NUL character, and be unique within one database instance. The first factory call records the query's structural SQL skeleton. Later calls may provide different parameter values, but their text, identifiers, segment kinds, and segment count must remain the same or typed-sql fails before driver dispatch.

Preparation is lazy: declaring the factory performs no I/O and checks out no connection. The first factory call compiles an immutable SQL skeleton; later calls verify the same structural segments and bind only their changing values. PostgreSQL uses the name for ordinary buffered execution. MySQL delegates execution to mysql2's per-connection prepared-statement cache.

## Execute an ordered batch

`database.batch(queries)` executes an ordered tuple or array on one leased connection. A const-generic tuple retains the exact result type for every position:

```ts
const accountQuery = sql`
  SELECT account.id, account.email
  FROM accounts AS account
  WHERE account.id = ${42n}
`;
const projectQuery = sql`
  SELECT project.id, project.name
  FROM projects AS project
  WHERE project.owner_id = ${42n}
`;

const [accounts, projects] = await database.batch([accountQuery, projectQuery]);
```

`accounts` and `projects` retain their respective inferred row arrays. Prepared queries remain ordinary `Query` values and can appear in the same batch. Passing an empty tuple returns immediately without acquiring a connection.

A root batch is sequential and non-atomic. It performs one driver execution per query on the same connection, stops at the first failure, and does not claim a single network round trip. Successfully completed statements are not rolled back when a later statement fails.

Use an explicit transaction when atomicity is required and supported by the statements and database:

```ts
const [accounts, projects] = await database.transaction((transaction) =>
  transaction.batch([accountQuery, projectQuery]),
);
```

Always await a transaction batch before returning from its callback. The adapters reject escaped or concurrent batch work rather than allowing queries to run after commit or connection release.

The surrounding database's transaction rules still apply. For example, MySQL statements that implicitly commit cannot be made atomic by placing them in a batch.

## Pipeline independent PostgreSQL queries

PostgreSQL applications using `pg` 8.23.0 or newer can opt into node-postgres pipeline mode and dispatch an exactly typed tuple without waiting for each preceding result:

```ts
const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  poolConfig: { pipeline: true },
});

const [accounts, projects] = await database.pipeline([accountQuery, projectQuery]);
```

`pipeline()` leases one client and calls `client.query()` for every input before awaiting their results. This uses node-postgres's public pipeline mode to remove the idle network round trip between independent queries. Results retain input order even when responses settle in another order, and prepared-query metadata remains attached.

This is deliberately separate from `batch()`. A pipeline cannot stop dispatch at the first failure because later statements are already in flight. typed-sql waits for every dispatched query to settle, reports the first input-order failure, and discards a root lease after failure. A root pipeline is not atomic; use an explicit transaction when all statements must commit or roll back together. Always await a transaction pipeline before its callback returns.

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

Transaction callbacks receive the selected adapter's transaction type, so `execute()`, `batch()`, `prepare()`, and `stream()` remain available:

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

A transaction stream must complete or close before its callback returns. It cannot escape the callback for later iteration. Every `execute()`, `batch()`, and PostgreSQL `pipeline()` call must also be awaited before returning. While a transaction stream, batch, or pipeline owns the connection, that connection cannot execute competing work or enter a nested transaction. If the callback returns with an execution still running, an open stream, a running batch, or a pipeline in flight, the adapter settles the work, reports the misuse, and rolls back instead of committing.

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
