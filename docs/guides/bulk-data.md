---
title: Transfer bulk data
description: Stream typed rows through optional PostgreSQL COPY and MySQL LOAD DATA adapter capabilities.
---

# Transfer bulk data

Bulk transfer is an optional adapter capability. It does not change the `sql` tag into a query
builder and it does not add database protocols to the grammar-neutral `Database` interface.
Applications discover the capability they need, while each dialect owns its native protocol and
failure semantics.

## Choose the execution form

| Form | Database work | Use it for |
| --- | --- | --- |
| Direct fragment list | One parameterized statement | A bounded, known non-empty set that should use one statement's result and failure semantics |
| `database.batch()` | Multiple sequential statements on one connection | Heterogeneous commands or per-command results; wrap it in a transaction when the statements must be atomic |
| Native bulk capability | PostgreSQL COPY or MySQL LOAD DATA | Large or streaming ingestion where bounded memory and protocol throughput matter |

For a direct multi-row statement, map every row to `sql.fragment` and interpolate the resulting
array without `sql.join()`. This does not silently become a batch or native bulk transfer. See
[Repeat homogeneous fragments](./composition.md#repeat-homogeneous-fragments).

The input contract is an ordinary typed, single-row `INSERT` factory. The compiler therefore checks
the target columns, their order, nullability, scalar types, and every interpolated value using the
same schema evidence as normal execution.

## Import rows with PostgreSQL COPY

Install the protocol stream beside the `pg` driver in the application:

```sh
pnpm add pg pg-copy-streams
```

```ts
import { requireAdapterCapability } from "@typed-sql/core";
import { postgresCopy, sql } from "@typed-sql/postgres";
import { createPgDatabase } from "@typed-sql/postgres/pg";

const database = await createPgDatabase({
  connectionString: process.env.DATABASE_URL!,
  // Resolve the application-owned package from the application's module graph.
  copyStreamsImporter: () => import("pg-copy-streams"),
});

const copy = requireAdapterCapability(database, postgresCopy);

interface AccountInput {
  readonly id: bigint;
  readonly email: string;
  readonly note: string | null;
}

const accountInsert = (row: AccountInput) => sql`
  INSERT INTO account (id, email, note)
  VALUES (${row.id}, ${row.email}, ${row.note})
`;

const result = await copy.copyFrom(accountInsert, accountSource(), {
  chunkBytes: 64 * 1024,
  onProgress(progress) {
    console.log(progress.rows, progress.bytes);
  },
});
```

`copyFrom()` accepts an `Iterable` or `AsyncIterable`, pulls it under native stream backpressure,
and keeps only a bounded encoded chunk in memory. The first query compiles the target table,
explicit column list, and structural SQL skeleton. Every later row must produce the same statement
shape. A conditional table, column, identifier, or fragment fails before that row is sent.

The factory must produce a plain single-row `INSERT` with one ordered parameter for each explicit
target column and no `RETURNING` clause. Values use PostgreSQL text input forms compatible with
ordinary typed-sql inputs, including bigint, finite numbers, booleans, dates, JSON values, arrays,
and `Uint8Array` bytea values. Unsupported JavaScript values fail closed.

Progress describes rows encoded and bytes yielded to the native stream. It is not a commit receipt.
Only the fulfilled `copyFrom()` result confirms that PostgreSQL accepted the complete transfer; an
outer transaction controls commit.

### Export raw PostgreSQL CSV

`copyTo()` accepts a static typed `SELECT` with no parameters and returns a lazy
`QueryStream<Uint8Array>`:

```ts
const output = copy.copyTo(sql`
  SELECT account.id, account.email, account.note
  FROM account
  ORDER BY account.id
`);

for await (const chunk of output) {
  await destination.write(chunk);
}
```

The query remains compiler-checked, but COPY returns PostgreSQL CSV bytes rather than decoded row
objects. A `break`, explicit `close()`, or async disposal stops the native stream and settles its
connection lease.

## Import rows with MySQL LOAD DATA

The mysql2 adapter provides an application-stream-only `LOAD DATA LOCAL INFILE` capability. The
application already owns its `mysql2` dependency; no additional protocol package is required.
MySQL must explicitly allow local infile requests, for example through the server's
`local_infile=ON` setting.

```ts
import { requireAdapterCapability } from "@typed-sql/core";
import { mysqlBulk, sql } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
});
const bulk = requireAdapterCapability(database, mysqlBulk);

interface AccountInput {
  readonly id: bigint;
  readonly email: string;
  readonly note: string | null;
}

const accountInsert = (row: AccountInput) => sql`
  INSERT INTO account (id, email, note)
  VALUES (${row.id}, ${row.email}, ${row.note})
`;

const result = await bulk.loadData(accountInsert, accountSource(), {
  chunkBytes: 64 * 1024,
});
```

The adapter supplies mysql2's `infileStreamFactory` itself and accepts only typed-sql's internal
sentinel path. It never opens a path requested by the server. Rows use an escaped UTF-8 tab format;
null is encoded distinctly from an empty string. Strings, bigint, finite numbers, and booleans use
the same stable scalar forms as ordinary execution. Date encoding depends on mysql2's connection
timezone, while binary and structured parameters have type-specific driver behavior; those values
are deliberately rejected in bulk text mode. Use ordinary parameterized execution when exact
driver encoding is required.

MySQL bulk export is not exposed because the selected adapter has no equally safe, application-owned
counterpart to PostgreSQL COPY TO. Use a typed query stream for large MySQL result sets.

## Transactions, cancellation, and failures

Resolve the capability from the transaction object to reuse its checked-out connection:

```ts
await database.transaction(async (transaction) => {
  const bulk = requireAdapterCapability(transaction, postgresCopy);
  await bulk.copyFrom(accountInsert, rows);
});
```

Always await bulk work before the transaction callback returns. While a native bulk protocol owns
the transaction connection, typed-sql rejects competing queries, batches, pipelines, streams, and
nested transactions.

Cancellation, a producer error, a database rejection, or native stream failure prevents a root
connection from returning to the reusable pool when its protocol state is uncertain. Inside a
transaction, the scope is invalidated and rolls back. An asynchronous producer should observe the
same `AbortSignal` when it performs its own cancellable I/O; JavaScript cannot forcibly interrupt an
arbitrary pending `iterator.next()` promise.

An empty input returns `{ rows: 0, bytes: 0 }` without loading the optional protocol package or
leasing a connection.

## Capability discovery

Generic infrastructure can inspect a capability without importing a driver:

```ts
import { getAdapterCapability } from "@typed-sql/core";
import { postgresCopy } from "@typed-sql/postgres";

const copy = getAdapterCapability(database, postgresCopy);
if (copy !== undefined) {
  await copy.copyFrom(accountInsert, rows);
}
```

`requireAdapterCapability()` throws `UnsupportedAdapterCapabilityError` with code
`TSQL_UNSUPPORTED_ADAPTER_CAPABILITY` when the selected adapter does not advertise the token.
The official PostgreSQL adapter advertises COPY before loading `pg-copy-streams`; if the application
did not install it, the first COPY operation instead reports the exact install command without
leasing a connection.

Capability tokens are namespaced, immutable, and based on stable global symbols. Adapter authors
can define additional services with `defineAdapterCapability()` and install them through the
grammar-neutral resolver contract without widening every database implementation.
