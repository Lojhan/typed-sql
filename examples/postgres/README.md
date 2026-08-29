# PostgreSQL example

This private workspace package uses `@typed-sql/postgres` from the checked-out branch and installs
`pg` as its application-owned driver.

From the repository root:

```sh
pnpm --filter @typed-sql/example-postgres db:up
pnpm --filter @typed-sql/example-postgres generate
pnpm --filter @typed-sql/example-postgres check
pnpm --filter @typed-sql/example-postgres start
pnpm --filter @typed-sql/example-postgres db:down
```

Set `TYPED_SQL_CONTAINER_ENGINE=podman` to use Podman instead of Docker. Set `DATABASE_URL` to run
against another PostgreSQL database.

The checked-in snapshot makes editor inference available immediately. Running `generate` replaces
it with a live introspection of the reproducible container.

After installing the Zed development extension, open this directory as its own workspace with
`zed examples/postgres` to use the included language-server settings.

See the [rendered PostgreSQL walkthrough](../../docs/examples/postgresql.md).
