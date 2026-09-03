# @typed-sql/mysql

The stable MySQL grammar for [typed-sql](https://github.com/Lojhan/typed-sql), including catalog
introspection, row and parameter inference, type policy, runtime codecs, and an optional
application-owned `mysql2` adapter, native live verifier, and structured-plan inspector.

```sh
pnpm add @typed-sql/core @typed-sql/mysql mysql2
pnpm add -D @typed-sql/cli typescript@7.0.2
```

`mysql2` is loaded only through `@typed-sql/mysql/mysql2`; it is not a dependency or peer dependency
of the grammar.

The stable grammar contract covers the MySQL 8.4 and 9.7 LTS series. Protected differential jobs
exercise exact 8.4.12 and 9.7.3 images under default, lexical, and unsigned-arithmetic SQL-mode
profiles. MySQL 26.7.1 is reported separately as a non-blocking innovation canary and requires
`mysql({ versionPolicy: "canary" })`.
These are the supported SQL-mode profiles; custom profiles containing an unmodeled mode fail closed.

```ts
import { requireAdapterCapability } from "@typed-sql/core";
import { mysqlBulk, sql, typePolicy } from "@typed-sql/mysql";
import { createMySql2Database } from "@typed-sql/mysql/mysql2";

const query = sql`
  SELECT account.id, account.email, project.budget
  FROM users AS account
  LEFT JOIN projects AS project ON project.owner_id = account.id
`;

const database = await createMySql2Database({
  connectionUri: process.env.DATABASE_URL!,
  typePolicy,
  preparedStatementLimit: 16_000,
  // observer: createOpenTelemetryObserver(),
});

const rows = await database.execute(query);

const accountById = database.prepare("account-by-id", (id: bigint) => sql`
  SELECT account.id, account.email
  FROM users AS account
  WHERE account.id = ${id}
`);

const [selectedAccounts, allAccounts] = await database.batch([accountById(42n), query]);

for await (const account of database.stream(accountById(42n), { batchSize: 500 })) {
  // account retains the query's inferred row type
}

const bulk = requireAdapterCapability(database, mysqlBulk);
await bulk.loadData(
  (account: { readonly id: bigint; readonly email: string }) =>
    sql`INSERT INTO users (id, email) VALUES (${account.id}, ${account.email})`,
  accounts,
);
```

The package root exports `sql`, `mysql`, and the MySQL type policy. The `/mysql2` entrypoint exports
the schema provider, execution adapter, `createMySql2LiveVerifier`, and `createMySql2PlanInspector`;
`/runtime` exposes driver-neutral MySQL rendering and codecs.

The adapter can validate a schema format 2 `compatibilitySnapshot` against each leased session,
report redacted execution warning counts through `onWarning`, reject warnings with
`rejectWarnings`, and bound prepared and decoder caches. Multi-statement strings remain disabled;
use the ordered batch API instead. The canonical MySQL guide documents these runtime contracts.

The root also exports `createMySqlRoutedDatabase`, the runtime semantic resolver, and the native
transaction retry classifier. These compose application-owned adapters without installing or
creating `mysql2` pools.

Read the [MySQL grammar guide](https://github.com/Lojhan/typed-sql/blob/main/docs/dialects/mysql.md),
[execution guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/execution.md),
[bulk data guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/bulk-data.md),
[observability guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/observability.md),
[live verification guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/live-verification.md),
[query plan governance guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-plan-governance.md),
[routing and retry guide](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/routing-and-retries.md),
[configuration](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md), and
[database type mappings](https://github.com/Lojhan/typed-sql/blob/main/docs/reference/type-mappings.md).

MIT © typed-sql contributors
