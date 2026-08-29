# MySQL example

This private workspace package uses `@typed-sql/mysql` from the checked-out branch and installs
`mysql2` as its application-owned driver.

From the repository root:

```sh
pnpm --filter @typed-sql/example-mysql db:up
pnpm --filter @typed-sql/example-mysql generate
pnpm --filter @typed-sql/example-mysql check
pnpm --filter @typed-sql/example-mysql start
pnpm --filter @typed-sql/example-mysql db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` to use Podman instead of Docker. Set `DATABASE_URL` to run
against another MySQL database.

The checked-in snapshot makes editor inference available immediately. Running `generate` replaces
it with a live introspection of the reproducible container.

After installing the Zed development extension, open this directory as its own workspace with
`zed examples/mysql` to use the included language-server settings.

See the [rendered MySQL walkthrough](../../docs/examples/mysql.md).
