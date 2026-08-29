# typed-sql 2.0.0-rc.0 competitive assessment

This is release evidence for typed-sql `2.0.0-rc.0`. It compares the release candidate with raw
drivers and representative TypeScript query builders and ORMs. Measurements describe one fixed
workload and environment. Feature and maturity conclusions are explicitly qualitative.

## Reproduction identity

- Candidate commit: `95b60a9e` (`release: prepare 2.0.0-rc.0`)
- typed-sql packages: `2.0.0-rc.0`
- Node.js: `24.10.0`
- Package manager: pnpm `10.32.1`
- Host: macOS `25.6.0`, arm64, Apple M3 Pro, 12 logical CPUs, 18 GiB memory
- Container engine: Podman
- PostgreSQL: `postgres:18.0-alpine`
- MySQL: `mysql:9.5`
- Transport: TCP loopback to isolated local containers

The comparison workspace pins these application dependencies exactly:

| Package | Version |
| --- | ---: |
| `pg` | 8.23.0 |
| `mysql2` | 3.24.1 |
| `pg-copy-streams` | 7.0.0 |
| `drizzle-orm` | 0.45.2 |
| `kysely` | 0.29.5 |
| `@prisma/client` and `@prisma/adapter-pg` | 7.10.0 |
| `typeorm` | 1.1.0 |

From the repository root, reproduce the measured run with:

```sh
pnpm build
cd benchmarks/runtime-comparison
pnpm install --frozen-lockfile

TYPED_SQL_CONTAINER_ENGINE=podman \
BENCHMARK_WARMUPS=500 \
BENCHMARK_SAMPLES=20 \
BENCHMARK_ITERATIONS=2000 \
BULK_BENCHMARK_ROW_COUNTS=100,1000,5000 \
BULK_BENCHMARK_WARMUPS=2 \
BULK_BENCHMARK_SAMPLES=5 \
pnpm run run
```

Use the alternate-port example in the benchmark README if the default ports are occupied. The run
writes unrounded machine-readable aggregates to `results/latest.json` and
`results/bulk-latest.json`; generated `latest` files remain ignored because host noise makes a
checked-in moving result misleading. The exact candidate outputs are preserved as
[request/prepared JSON](./evidence/2.0.0-rc.0/runtime-comparison.json) and
[bulk JSON](./evidence/2.0.0-rc.0/bulk-comparison.json). The complete rounded output is also recorded
below for review without tooling.

## Methodology

The request workload executes the idiomatic public API for each library against the same indexed
1,000-row table and returns the same three columns. It includes query construction, driver dispatch,
one local database round trip, and row decoding. Pools have a limit of ten and operations are
sequential. Each of 20 measured samples contains 2,000 operations after 500 warm-up operations.

Prepared PostgreSQL results are separate because only raw `pg`, typed-sql, and Drizzle expose a
directly comparable named/prepared path in this fixture. MySQL `execute()` uses mysql2's per-connection
statement cache, so both its raw and typed-sql request paths already use that protocol.

The bulk workload generates all inputs before timing, truncates its isolated target before each run,
times only ingestion, and verifies the committed row count afterward. It measures five samples after
two warm-ups at 100, 1,000, and 5,000 rows. Native COPY and LOAD DATA are not compared with ordinary
multi-row ORM inserts because they are different database protocols.

## Request and prepared results

Lower p50 and p95 latency is better. Operations per second is derived from p50.

| Database | Workload | Library | p50 ms | p95 ms | ops/s |
| --- | --- | --- | ---: | ---: | ---: |
| PostgreSQL | request | raw pg | 0.186 | 0.194 | 5,372 |
| PostgreSQL | request | typed-sql | 0.185 | 0.192 | 5,403 |
| PostgreSQL | request | Drizzle | 0.208 | 0.210 | 4,818 |
| PostgreSQL | request | Kysely | 0.190 | 0.196 | 5,277 |
| PostgreSQL | request | Prisma | 0.225 | 0.230 | 4,446 |
| PostgreSQL | request | TypeORM | 0.197 | 0.201 | 5,077 |
| PostgreSQL | prepared | raw pg named prepared | 0.170 | 0.172 | 5,877 |
| PostgreSQL | prepared | typed-sql prepared | 0.171 | 0.177 | 5,837 |
| PostgreSQL | prepared | Drizzle prepared | 0.172 | 0.176 | 5,826 |
| MySQL | request | raw mysql2 execute | 0.179 | 0.182 | 5,581 |
| MySQL | request | typed-sql | 0.182 | 0.187 | 5,495 |
| MySQL | prepared | typed-sql prepared | 0.186 | 0.189 | 5,386 |

The ordinary typed-sql PostgreSQL path was 0.6% faster than raw `pg` at p50 in this run. That is
measurement noise, not evidence that a wrapper makes the database faster. The useful conclusion is
that no material wrapper overhead was observable in this workload. The prepared typed-sql path was
0.7% slower than raw named `pg`; the ordinary MySQL path was 1.6% slower than raw mysql2.

## Bulk results

Higher rows per second is better. These are the complete candidate-run aggregates.

| Database | Strategy | Library | Rows | p50 ms | p95 ms | rows/s |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| PostgreSQL | bulk | typed-sql COPY FROM | 100 | 1.11 | 1.36 | 89,800 |
| PostgreSQL | batch | typed-sql ordered batch | 100 | 26.53 | 27.08 | 3,769 |
| PostgreSQL | pipeline | typed-sql native pipeline | 100 | 12.28 | 12.45 | 8,142 |
| PostgreSQL | direct driver | raw pg-copy-streams | 100 | 1.21 | 1.24 | 82,844 |
| PostgreSQL | direct driver | raw pg named inserts | 100 | 21.44 | 22.02 | 4,664 |
| MySQL | bulk | typed-sql LOAD DATA | 100 | 2.07 | 2.34 | 48,213 |
| MySQL | batch | typed-sql ordered batch | 100 | 49.26 | 68.36 | 2,030 |
| MySQL | direct driver | raw mysql2 LOAD DATA | 100 | 1.93 | 2.00 | 51,810 |
| MySQL | direct driver | raw mysql2 execute inserts | 100 | 46.66 | 47.75 | 2,143 |
| PostgreSQL | bulk | typed-sql COPY FROM | 1,000 | 4.47 | 5.29 | 223,674 |
| PostgreSQL | batch | typed-sql ordered batch | 1,000 | 270.26 | 300.51 | 3,700 |
| PostgreSQL | pipeline | typed-sql native pipeline | 1,000 | 121.26 | 130.08 | 8,246 |
| PostgreSQL | direct driver | raw pg-copy-streams | 1,000 | 5.80 | 6.08 | 172,333 |
| PostgreSQL | direct driver | raw pg named inserts | 1,000 | 212.29 | 258.29 | 4,711 |
| MySQL | bulk | typed-sql LOAD DATA | 1,000 | 7.45 | 8.58 | 134,217 |
| MySQL | batch | typed-sql ordered batch | 1,000 | 470.74 | 498.43 | 2,124 |
| MySQL | direct driver | raw mysql2 LOAD DATA | 1,000 | 7.67 | 7.87 | 130,297 |
| MySQL | direct driver | raw mysql2 execute inserts | 1,000 | 474.56 | 478.55 | 2,107 |
| PostgreSQL | bulk | typed-sql COPY FROM | 5,000 | 12.22 | 12.39 | 409,054 |
| PostgreSQL | batch | typed-sql ordered batch | 5,000 | 1,346.60 | 1,356.81 | 3,713 |
| PostgreSQL | pipeline | typed-sql native pipeline | 5,000 | 597.65 | 623.94 | 8,366 |
| PostgreSQL | direct driver | raw pg-copy-streams | 5,000 | 19.06 | 19.72 | 262,369 |
| PostgreSQL | direct driver | raw pg named inserts | 5,000 | 1,232.15 | 1,312.59 | 4,058 |
| MySQL | bulk | typed-sql LOAD DATA | 5,000 | 35.85 | 39.35 | 139,452 |
| MySQL | batch | typed-sql ordered batch | 5,000 | 2,352.04 | 2,404.47 | 2,126 |
| MySQL | direct driver | raw mysql2 LOAD DATA | 5,000 | 33.52 | 37.71 | 149,157 |
| MySQL | direct driver | raw mysql2 execute inserts | 5,000 | 2,350.81 | 2,383.45 | 2,127 |

The native typed-sql paths are in the same performance class as direct protocol use. The PostgreSQL
COPY result was faster than the direct fixture in this run, while MySQL LOAD DATA was 6.5% slower at
5,000 rows. Neither result establishes a universal ranking: stream construction, chunking, host
scheduling, and server state can dominate small local transfers. The durable conclusion is that
typed-sql exposes native protocols without reducing them to slow per-row emulation. Ordered batch is
intentionally sequential and should not be presented as a bulk substitute; PostgreSQL pipeline is
faster than sequential statements but remains far behind COPY for ingestion.

## Feature completeness

This table is a qualitative product comparison, not benchmark output. “Application-owned” means the
library leaves the concern to the installed driver or another tool instead of pretending to own it.

| Capability | typed-sql 2.0 RC | Raw pg/mysql2 | Kysely | Drizzle | Prisma | TypeORM |
| --- | --- | --- | --- | --- | --- | --- |
| Native SQL is the primary query language | Yes | Yes | No, builder plus SQL escape hatch | No, builder plus SQL escape hatch | No, model client plus TypedSQL/raw SQL | No, repositories/query builder plus raw SQL |
| Infer rows and ordered parameters from inline supported SQL | Yes | No; caller supplies generics | Builder inference; raw SQL needs caller type | Builder inference; raw fragments need caller type | Generated model/TypedSQL types; legacy raw SQL needs caller type | Entity/query-builder types; raw SQL needs caller type |
| Database-first schema introspection | PostgreSQL, MySQL, SQLite snapshots | No shared model | External/codegen ecosystem | Yes | Yes | Yes |
| Relations, eager loading, cascades, unit of work | No | No | Joins, not an ORM relation layer | Yes | Yes | Yes |
| Schema authoring DSL | No | No | Type interfaces, not DDL ownership | Yes | Yes | Entity metadata |
| Migration generation and execution | No; compatibility analysis only | No | Migration runner, no schema diff generator | Yes | Yes | Yes |
| Cardinality APIs and typed tuples | `all`, `one`, `maybeOne`, `batch`, PostgreSQL `pipeline` | Manual | Result helpers and transactions | Result helpers and transactions | Client helpers and transactions | Repository/query-builder helpers and transactions |
| Lazy typed streaming | PostgreSQL, MySQL, SQLite | Driver/package-specific | Yes | Dialect-specific | Not a general relational cursor API | Query-builder streaming is driver-dependent |
| Native bulk protocols | PostgreSQL COPY and MySQL LOAD DATA capabilities | Available through driver/protocol packages | Application-owned | Application-owned | Application-owned | Application-owned |
| Cancellation and deadlines | Uniform execution contract with conservative connection cleanup | Driver-specific | Abort support is dialect-dependent | Driver-specific | Client/runtime-specific | Driver-specific |
| Read routing and bounded transaction retry | Semantic read-safety plus application-owned topology | Manual | Application-owned | Replica APIs; retry policy application-owned | Replica extension; retry policy application-owned | Replication; retry policy application-owned |
| Runtime result validation | Standard Schema V1, optional | Manual | Plugin/application-owned | Application-owned | Generated runtime mapping; boundary validation application-owned | Entity transformation; boundary validation application-owned |
| Query identity and redacted observation | Stable fingerprints plus optional OpenTelemetry bridge | Manual/instrumentation-specific | Plugin/application-owned | Logging/tracing integration | Logging/tracing integration | Logging/subscriber integration |
| Deterministic query manifests | Yes | No | No | No | Generated-client artifacts, not the same query manifest contract | No |
| Live database proof and cached offline verification | PostgreSQL and MySQL | Manual | No integrated proof artifact | No integrated proof artifact | No equivalent query-evidence artifact | No integrated proof artifact |
| Query-aware migration compatibility and plan budgets | Yes, analysis only | Manual | No integrated query contract | Migration tooling, not deployed-query compatibility | Migration tooling, not the same deployed-query contract | Migration tooling, not the same deployed-query contract |
| Driver dependency in the grammar/core package | No | The driver is the API | Dialect/driver required by the app | Driver required by the app | Adapter/engine required by the app | Driver required by the app |

The comparison reflects the documented public surfaces of
[Kysely](https://kysely-org.github.io/kysely-apidoc/),
[Drizzle relations](https://orm.drizzle.team/docs/relations),
[Drizzle migrations](https://orm.drizzle.team/docs/migrations),
[Prisma raw and TypedSQL queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries),
[TypeORM features](https://typeorm.io/docs/getting-started/),
[node-postgres queries](https://node-postgres.com/features/queries), and
[node-postgres transactions](https://node-postgres.com/features/transactions). Exact capabilities
change independently; the pinned runtime benchmark does not prove every matrix cell.

## Code quality and maintenance evidence

The following facts are reproducible repository evidence at the candidate commit:

- 13 public packages are versioned together: 10 stable and 3 experimental.
- Stable packages cannot depend on preview TypeScript/editor packages. Grammar packages do not
  depend directly on database drivers, validators, or OpenTelemetry SDKs.
- The public third-party grammar fixture imports published entrypoints only and passes the neutral
  conformance kit.
- There are 68 package test files and 18 contract/E2E test files, totaling 17,675 package-test lines
  against 26,515 package-source lines.
- Core, AST, schema, config, compiler, PostgreSQL, and MySQL enforce 95% statement/line/function and
  90% branch floors. The candidate run measured core at 98.22% statements and 92.46% branches,
  PostgreSQL at 96.54% and 90.28%, and MySQL at 96.92% and 90.29%.
- SQLite measured 97.05% statements and 87.31% branches against its experimental 90%/85% floors.
- `pnpm verify` passed quality, every package and contract test, enforced coverage, production build,
  documentation build, and scanner/compiler/runtime/editor performance budgets.
- Packed external acceptance passed against real PostgreSQL, MySQL, and SQLite without workspace
  fallback. `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- Release publication separates the stable and experimental tracks and verifies package contents,
  dependency boundaries, registry installation, generation, execution, and editor artifacts.

These checks reduce regression risk; they do not replace ecosystem maturity. typed-sql has a much
shorter compatibility history, smaller contributor community, and less production exposure than the
raw drivers and established query builders/ORMs in this comparison. That is the principal release
risk, not measured request overhead.

## Decision

No performance, dependency, package-boundary, or code-quality blocker was found for an RC.
typed-sql is strongest for teams that want to keep native SQL, infer its contract, retain near-driver
runtime behavior, and carry compiler evidence into deployment checks. It is materially more complete
than using a raw driver for type inference, query identity, validation integration, observability,
and deployment governance.

It is not feature-complete as an ORM and does not intend to become one. Applications that prioritize
model relations, cascades, change tracking, schema-as-code, or an integrated migration runner should
use an ORM or query-builder ecosystem, potentially alongside typed-sql for complex native SQL.
Applications that need every driver feature immediately, accept manual typing and governance, and
want the smallest possible abstraction should continue using the driver directly.

The RC should ship with PostgreSQL and MySQL on the stable track. SQLite, the TypeScript preview
bridge, and the language server remain experimental and must not block stable-package installation or
publication. Stable 2.0 should require the same clean CI and registry evidence, but no arbitrary soak
period or external-consumer count.
