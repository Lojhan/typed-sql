# @typed-sql/sqlite

The preview SQLite grammar for typed-sql. It provides sound inference for SQLite's dynamic type
system, schema introspection, and an optional application-owned `node:sqlite` adapter.

```sh
pnpm add @typed-sql/core @typed-sql/sqlite
pnpm add -D @typed-sql/cli typescript@7.0.2
```

```ts
import { sql, typePolicy } from "@typed-sql/sqlite";
import { createNodeSqliteDatabase } from "@typed-sql/sqlite/node-sqlite";

const query = sql`
  SELECT account.id, account.email
  FROM account
  WHERE account.id = ${42n}
`;

const database = await createNodeSqliteDatabase({ path: "app.db", typePolicy });
const accounts = await database.execute(query);
await database.close();
```

The package root has no database-driver dependency. `/node-sqlite` loads the built-in Node module
only when the application selects that adapter. STRICT tables receive precise declared types;
ordinary SQLite tables use a storage-class union because their declared affinity does not constrain
the values they may contain.

SQLite support remains on the experimental release track while its grammar and adapter contracts
are exercised by early adopters.

MIT © typed-sql contributors
