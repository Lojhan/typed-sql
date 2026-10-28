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

## Reylo and SQL-file comparison

The SQLite workload runs locally on Node.js 24 using its built-in driver. It compares current
checkout packages with pinned Reylo 0.6.0: raw cached/prepared-per-call statements, typed-sql
inline and logical prepared factories, typed-sql SQL-file factories with and without preparation,
and Reylo's normal asynchronous and synchronous SQL-file APIs. This same comparison also supports
PostgreSQL and MySQL using their respective grammar and driver packages. The SQLite command does
not start any container. SQL-file execution requires Node.js 24.11.1 or newer in the 24.x line.

After building the root packages and installing this workspace, run:

```sh
SQLITE_BENCHMARK_TRIALS=3 SQLITE_BENCHMARK_SAMPLES=12 \
SQLITE_BENCHMARK_ITERATIONS=1500 pnpm benchmark:sqlite
```

Run the network variants against dedicated disposable databases. These commands recreate only
their `runtime_account` fixture table; do not point them at an application database:

```sh
POSTGRES_URL=postgresql://postgres@127.0.0.1:5432/typed_sql_benchmark \
RUNTIME_BENCHMARK_TRIALS=3 RUNTIME_BENCHMARK_SAMPLES=12 \
RUNTIME_BENCHMARK_ITERATIONS=1500 pnpm benchmark:postgres

MYSQL_URL=mysql://root:password@127.0.0.1:3306/typed_sql_benchmark \
RUNTIME_BENCHMARK_TRIALS=3 RUNTIME_BENCHMARK_SAMPLES=12 \
RUNTIME_BENCHMARK_ITERATIONS=1500 pnpm benchmark:mysql
```

Network candidates use pools with a maximum of ten connections. PostgreSQL's raw cached path
uses a named prepared statement; its other raw path uses an unnamed parameterized query.
MySQL's cached path uses `mysql2.execute`, while its other raw path uses the text protocol through
`mysql2.query`. There is no synchronous Reylo candidate for network drivers. Network concurrency
1 and 8 measure separate workloads and can use independent physical connections. The JSON
aggregate's record order is not part of the workload guarantee.

Every worker gets a fresh project and identical 1,000-row database. Separate processes avoid
competing SQL-file loader hooks. Candidate order is shuffled reproducibly within each trial.
The point lookup returns one row; the range workload returns 32 rows; the JSON aggregate returns
the same 32 records as parsed JSON. JSON parsing is inside the timed operation whenever the
driver/frontend returns text. This avoids comparing decoded Reylo objects with undecoded text.
SQL files use a prebuilt offline snapshot for typed-sql and Reylo's normal live-schema analysis;
their different prerequisites remain part of the reported startup costs.

Cold startup measures process spawn through its first validated query report, including loader
imports and analysis, with fixture creation excluded. First API-call latency is recorded separately
after imports and candidate setup. Filesystem caches are not flushed. Warm runs retain all sample
durations, CPU usage and environment/version/commit identities. Samples are batch-average
milliseconds per operation: their p95 is not an individual request latency percentile. Concurrency
1 and 8 are separate workloads over one connection, measuring queued logical calls rather than
parallel SQLite I/O. Typed-sql retains transaction/stream serialization; Reylo executes directly on
the supplied synchronous connection and does not provide that ownership queue.

Use `SQLITE_BENCHMARK_CANDIDATES`, `SQLITE_BENCHMARK_WORKLOADS` (`point,multirow,json`) and
`SQLITE_BENCHMARK_CONCURRENCY` to select cases. The same controls accept the
`RUNTIME_BENCHMARK_` prefix for all three engines. `SQLITE_BENCHMARK_OUTPUT` selects the output JSON
relative to this workspace. Results and synthetic fixture databases stay under ignored `results/`.

Profile steady-state work separately from latency measurements:

```sh
SQLITE_BENCHMARK_PROFILE=cpu SQLITE_BENCHMARK_TRIALS=1 \
SQLITE_BENCHMARK_CONCURRENCY=1 SQLITE_BENCHMARK_CANDIDATES=typed-prepared \
pnpm benchmark:sqlite

SQLITE_BENCHMARK_PROFILE=alloc SQLITE_BENCHMARK_TRIALS=1 \
SQLITE_BENCHMARK_CONCURRENCY=1 SQLITE_BENCHMARK_CANDIDATES=typed-prepared \
pnpm benchmark:sqlite
```

The profile paths are recorded in the report. CPU sampling and allocation sampling use separate
runs after warm-up. Allocation sampling includes objects collected by minor and major GC;
sampling estimates allocated bytes, while the ordinary heap-used delta is only retained-heap noise.
Profiler-instrumented timings are not comparable with normal benchmark timings. Open the raw
`.cpuprofile` and `.heapprofile` files in DevTools for attribution.
