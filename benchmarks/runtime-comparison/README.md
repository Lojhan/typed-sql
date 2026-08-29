# Runtime comparison benchmark

This isolated workspace contains two reproducible database-backed comparisons.

The indexed lookup workload compares:

- raw `pg` and raw `mysql2`;
- typed-sql on PostgreSQL and MySQL;
- Drizzle, Kysely, Prisma, and TypeORM on PostgreSQL;
- named/prepared paths where the library exposes a comparable public API.

The bulk-ingestion workload compares multiple row counts through:

- typed-sql PostgreSQL COPY, ordered batch, and native pipeline;
- direct `pg-copy-streams` COPY and raw named `pg` inserts;
- typed-sql MySQL LOAD DATA and ordered batch;
- direct mysql2 LOAD DATA and raw mysql2 execute inserts.

It is a reproducible experiment, not a universal leaderboard. Database version, host scheduling, connection transport, driver version, result decoding, pool configuration, and query shape all affect the result. The committed harness is the claim; generated numbers are intentionally ignored.

The [2.0.0-rc.0 assessment](./ASSESSMENT.md) records one version-pinned run, its complete aggregated
results, and a feature and maintenance comparison. Treat that document as release evidence for the
named versions and environment, not as a timeless performance claim.

## Run it

Build typed-sql from the repository root first. Then run the isolated benchmark workspace:

```sh
pnpm build
cd benchmarks/runtime-comparison
pnpm install --frozen-lockfile
pnpm run
```

`pnpm run` starts fixed PostgreSQL and MySQL containers, generates Prisma Client, warms every candidate, runs both workloads, and writes `results/latest.json` plus `results/bulk-latest.json`. The runner uses Docker Compose when available and falls back to Podman Compose; set `TYPED_SQL_CONTAINER_ENGINE=docker` or `podman` to require one explicitly. Stop and remove the databases afterward:

```sh
pnpm databases:stop
```

If the default host ports are occupied, keep the container mappings and benchmark URLs aligned:

```sh
TYPED_SQL_BENCHMARK_POSTGRES_PORT=55440 \
TYPED_SQL_BENCHMARK_MYSQL_PORT=53310 \
POSTGRES_URL=postgresql://typed_sql:typed_sql@127.0.0.1:55440/typed_sql_benchmark \
MYSQL_URL=mysql://typed_sql:typed_sql@127.0.0.1:53310/typed_sql_benchmark \
pnpm run
```

The workspace applies a narrow pnpm override from Prisma's config package to
`deepmerge-ts@8.0.2`. Prisma 7.10.0 pins a release affected by
[GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), while the patched
major retains the `deepmerge` entrypoint Prisma uses. Keep the override until Prisma resolves a
patched release itself.

You can adjust measurement depth without editing the fixture:

```sh
BENCHMARK_WARMUPS=500 BENCHMARK_SAMPLES=20 BENCHMARK_ITERATIONS=2000 pnpm benchmark
```

Run or resize only the bulk workload with:

```sh
BULK_BENCHMARK_ROW_COUNTS=100,1000,5000 BULK_BENCHMARK_WARMUPS=1 BULK_BENCHMARK_SAMPLES=3 pnpm benchmark:bulk
```

## Methodology

The request workload constructs and executes each library's idiomatic lookup API. It includes SQL/query-builder work, driver dispatch, a local database round trip, and row decoding. The prepared workload is reported separately because only raw `pg`, typed-sql, and Drizzle expose directly comparable named/prepared APIs here; `mysql2.execute()` already uses its per-connection statement cache.

All candidates select the same three columns from the same 1,000-row indexed table. They use a pool limit of ten and execute sequentially so pool contention does not obscure per-request overhead. Each measured sample contains many operations; the report uses per-operation p50 and p95 sample latency.

The harness deliberately does not compare migrations, schema authoring, relation loading, unit-of-work behavior, or application-level ergonomics. Those are product capabilities, not runtime lookup costs.

The bulk workload truncates its isolated target before every warm-up and sample, times only the
ingestion call, then verifies the committed row count outside the timed region. Inputs are generated
before timing. Every strategy inserts the same three scalar columns; COPY and LOAD DATA use
application-owned streams rather than server filesystem paths. Batch and direct prepared-insert
paths remain intentionally sequential, while PostgreSQL pipeline dispatches all statements before
awaiting results. The benchmark reports throughput separately for each row count instead of
extrapolating one small transfer.

The APIs follow the projects' public documentation: [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql), [Drizzle prepared queries](https://orm.drizzle.team/docs/perf-queries), [Kysely](https://kysely.dev/), [Prisma PostgreSQL driver adapter](https://www.prisma.io/docs/orm/overview/databases/postgresql), and [TypeORM QueryBuilder](https://typeorm.io/docs/query-builder/select-query-builder/).
