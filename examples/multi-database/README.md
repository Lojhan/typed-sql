# PostgreSQL and SQLite example

This private workspace package shows one application using two grammar packages and two explicit
drivers. PostgreSQL owns customer records; a local SQLite database owns customer preferences.

From the repository root:

```sh
pnpm --filter @typed-sql/example-multi-database db:up
pnpm --filter @typed-sql/example-multi-database generate
pnpm --filter @typed-sql/example-multi-database check
pnpm --filter @typed-sql/example-multi-database test
pnpm --filter @typed-sql/example-multi-database start
pnpm --filter @typed-sql/example-multi-database test:database
pnpm --filter @typed-sql/example-multi-database db:down
```

The two database directories have independent configs, generated snapshots, grammar imports, and
queries. `src/service.ts` combines their inferred results. Its SQLite write is deliberately local:
typed-sql does not claim a distributed transaction across unrelated drivers.

For dialect-specific editor inference, open either `examples/multi-database/postgres` or
`examples/multi-database/sqlite` as a Zed workspace. Each directory selects its own config while
the shared TypeScript project remains one level above.

See the [rendered multi-database walkthrough](../../docs/examples/multi-database.md).
