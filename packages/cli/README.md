# @typed-sql/cli

The config-driven command line interface for [typed-sql](https://github.com/Lojhan/typed-sql).
It generates deterministic database snapshots, verifies inferred queries through TypeScript 7, and
detects live schema drift.

```sh
pnpm add -D @typed-sql/cli@next typescript@7.0.2
```

Install one dialect and its application-owned driver, then create `typed-sql.config.ts` as shown in
the [root guide](https://github.com/Lojhan/typed-sql#configure-the-database-contract).

```sh
pnpm exec typed-sql --help
pnpm exec typed-sql --version
```

```sh
# Introspect the configured database and write schema metadata.
pnpm exec typed-sql generate

# Compile SQL inference into an isolated overlay and ask TypeScript 7 to check it.
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json

# Compare the committed snapshot with the current live catalog and type policy.
pnpm exec typed-sql drift
```

Use `--config path/to/typed-sql.config.ts` when discovery is not appropriate. `generate` also accepts
`--out`; `check` accepts `--file` and `--project`.

The CLI contains no PostgreSQL, MySQL, `pg`, or `mysql2` dependency. It loads the installed dialect
and schema provider through the project config. Diagnostics use the versioned
[`TSQ` registry](https://github.com/Lojhan/typed-sql/tree/main/packages/core#diagnostics).

MIT © typed-sql contributors
