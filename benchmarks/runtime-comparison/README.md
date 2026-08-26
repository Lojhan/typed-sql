# Runtime comparison benchmark

This isolated workspace compares the runtime cost of one indexed account lookup through:

- raw `pg` and raw `mysql2`;
- typed-sql on PostgreSQL and MySQL;
- Drizzle, Kysely, Prisma, and TypeORM on PostgreSQL;
- named/prepared paths where the library exposes a comparable public API.

It is a reproducible experiment, not a universal leaderboard. Database version, host scheduling, connection transport, driver version, result decoding, pool configuration, and query shape all affect the result. The committed harness is the claim; generated numbers are intentionally ignored.

## Run it

Build typed-sql from the repository root first. Then run the isolated benchmark workspace:

```sh
pnpm build
cd benchmarks/runtime-comparison
pnpm install --frozen-lockfile
pnpm run
```

`pnpm run` starts fixed PostgreSQL and MySQL containers, generates Prisma Client, warms every candidate, measures sequential request latency, and writes `results/latest.json`. The runner uses Docker Compose when available and falls back to Podman Compose; set `TYPED_SQL_CONTAINER_ENGINE=docker` or `podman` to require one explicitly. Stop and remove the databases afterward:

```sh
pnpm databases:stop
```

You can adjust measurement depth without editing the fixture:

```sh
BENCHMARK_WARMUPS=500 BENCHMARK_SAMPLES=20 BENCHMARK_ITERATIONS=2000 pnpm benchmark
```

## Methodology

The request workload constructs and executes each library's idiomatic lookup API. It includes SQL/query-builder work, driver dispatch, a local database round trip, and row decoding. The prepared workload is reported separately because only raw `pg`, typed-sql, and Drizzle expose directly comparable named/prepared APIs here; `mysql2.execute()` already uses its per-connection statement cache.

All candidates select the same three columns from the same 1,000-row indexed table. They use a pool limit of ten and execute sequentially so pool contention does not obscure per-request overhead. Each measured sample contains many operations; the report uses per-operation p50 and p95 sample latency.

The harness deliberately does not compare migrations, schema authoring, relation loading, unit-of-work behavior, or application-level ergonomics. Those are product capabilities, not runtime lookup costs.

The APIs follow the projects' public documentation: [Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql), [Drizzle prepared queries](https://orm.drizzle.team/docs/perf-queries), [Kysely](https://kysely.dev/), [Prisma PostgreSQL driver adapter](https://www.prisma.io/docs/orm/overview/databases/postgresql), and [TypeORM QueryBuilder](https://typeorm.io/docs/query-builder/select-query-builder/).
