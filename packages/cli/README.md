# @typed-sql/cli

The stable, config-driven command line interface for
[typed-sql](https://github.com/Lojhan/typed-sql). It generates deterministic database snapshots,
checks inferred queries through TypeScript, detects schema drift, and emits deterministic query manifests.

```sh
pnpm add -D @typed-sql/cli typescript@7.0.2
```

Install a grammar and its application-owned driver, then create `typed-sql.config.ts`.

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
pnpm exec typed-sql manifest
```

Use `--config path/to/typed-sql.config.ts` to bypass config discovery. Run
`pnpm exec typed-sql --help` for command options.

The CLI contains no PostgreSQL, MySQL, `pg`, or `mysql2` dependency. It loads the installed grammar
and schema provider through the application config. Read
[Configuration](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md) and
[Schema snapshots](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/schema-snapshots.md), and
[Query manifests](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-manifests.md).

MIT © typed-sql contributors
