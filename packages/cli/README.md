# @typed-sql/cli

The stable, config-driven command line interface for
[typed-sql](https://github.com/Lojhan/typed-sql). It generates deterministic database snapshots,
checks inferred queries through TypeScript, detects schema drift, emits deterministic query manifests,
verifies compiler evidence through optional native database metadata, captures redacted structured
query plans, reviews explicit plan budgets, and analyzes migrations against compiled query contracts.

```sh
pnpm add -D @typed-sql/cli typescript@7.0.2
```

Install a grammar and its application-owned driver, then create `typed-sql.config.ts`.

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
pnpm exec typed-sql manifest
pnpm exec typed-sql verify --live
pnpm exec typed-sql verify
pnpm exec typed-sql explain --compare artifacts/plans.json
pnpm exec typed-sql compat --before before.schema.json --after after.schema.json --before-manifest before.queries.json --after-manifest after.queries.json
```

Use `--config path/to/typed-sql.config.ts` to bypass config discovery. Run
`pnpm exec typed-sql --help` for command options.

The CLI contains no PostgreSQL, MySQL, `pg`, or `mysql2` dependency. It loads the installed grammar
and schema provider through the application config. Read
[Configuration](https://github.com/Lojhan/typed-sql/blob/main/docs/getting-started/configuration.md) and
[Schema snapshots](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/schema-snapshots.md), and
[Query manifests](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-manifests.md).
[Live verification](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/live-verification.md) documents
native safety, cached proofs, and CI behavior.
[Query plan governance](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/query-plan-governance.md)
documents structured evidence, transient parameter samples, budgets, and optimizer uncertainty.
[Migration compatibility](https://github.com/Lojhan/typed-sql/blob/main/docs/guides/migration-compatibility.md)
documents deterministic reports, rolling deployments, and migration-runner integration.

MIT © typed-sql contributors
