# SQLite example

This private workspace package uses `@typed-sql/sqlite` from the checked-out branch and Node's
built-in `node:sqlite` driver.

From the repository root:

```sh
pnpm --filter @typed-sql/example-sqlite generate
pnpm --filter @typed-sql/example-sqlite check
pnpm --filter @typed-sql/example-sqlite start
```

`generate` recreates a local SQLite file, introspects it, and refreshes the checked-in generated
schema. `start` recreates the database and executes the typed query.

After installing the Zed development extension, open this directory as its own workspace with
`zed examples/sqlite` to use the included language-server settings.

See the [rendered SQLite walkthrough](../../docs/examples/sqlite.md).
