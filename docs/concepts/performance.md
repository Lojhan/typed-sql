---
title: Performance
description: Review typed-sql's measured compiler, composition, and editor regression limits.
---

# Performance

typed-sql treats compiler and editor responsiveness as a product constraint. The limits below are regression guardrails measured on production builds, not latency promises for every project or machine.

Every measurement records the Node.js version, operating system, architecture, CPU model, logical CPU count, total memory, CI status, and budget version.

## Measured work

The production performance suite covers:

- scanning one TypeScript file containing 1,000 static queries;
- compiling 250 queries with the PostgreSQL grammar and resolver;
- emitting a 250-query manifest and reusing its unchanged per-file analysis;
- scheduling and comparing native evidence for a 250-query verification manifest with bounded concurrency;
- correlated and independent conditional structure;
- rejecting structural expansion before grammar work exceeds its bound;
- core template construction, fragment composition, rendering, and prepared-skeleton binding;
- adapter render, encode, decode, decoder-plan compilation and cache-hit throughput, 100-row stream, 25-query batch, and PostgreSQL pipeline overhead with deterministic fake drivers;
- cold, unchanged, incrementally edited, and schema-reloaded language-service analysis;
- cancellation before expensive analysis;
- retained heap under cache pressure.

The structural scenarios assert their analysis counts as well as their timing. A fast but incorrect implementation does not pass.

Adapter microbenchmarks are tracking baselines rather than database latency claims or release budgets. They isolate typed-sql's local work from network, server, pool, and native-driver time so regressions remain visible without presenting fixture timings as production throughput.

## Driver and ORM comparison

The repository also contains an [isolated runtime comparison](https://github.com/Lojhan/typed-sql/tree/main/benchmarks/runtime-comparison) against raw `pg`, raw `mysql2`, Drizzle, Kysely, Prisma, and TypeORM. It runs one indexed lookup against fixed PostgreSQL and MySQL containers and reports ordinary request paths separately from comparable prepared paths.

Generated comparison results are not committed. They depend on the machine, database transport, operating-system scheduling, and dependency versions. The durable public artifact is the pinned fixture and its methodology, which lets maintainers and users reproduce a result on the hardware that matters to them.

At runtime, interpolation-free fragment templates may reuse their complete immutable value at the same JavaScript callsite. Query templates and parameterized fragments reuse only immutable text segments; their containing query and value segments remain isolated per call so one invocation cannot retain another invocation's execution metadata or parameters.

## Latency budgets

| Scenario | p50 | p95 |
| --- | ---: | ---: |
| Scanner, 1,000 queries | 10 ms | 25 ms |
| Compiler, 250 PostgreSQL queries | 20 ms | 50 ms |
| Query manifest, 250 queries | 25 ms | 60 ms |
| Query manifest, unchanged source | 0.5 ms | 1 ms |
| Query verification, 250 cached native responses | 15 ms | 35 ms |
| 20 correlated conditions | 5 ms | 10 ms |
| Six independent conditions | 10 ms | 25 ms |
| Structural limit rejection | 5 ms | 10 ms |
| Editor cold analysis | 75 ms | 150 ms |
| Editor incremental analysis | 30 ms | 75 ms |
| Editor unchanged cache hit | 0.5 ms | 1 ms |
| Editor schema reload | 30 ms | 75 ms |
| Editor cancelled request | 1 ms | 2 ms |

Core composition and rendering must sustain a p50 of at least 250,000 operations per second. The bounded editor cache may retain at most 16 MiB after garbage collection in the memory fixture.

## Measurement method

Latency scenarios use warm-up executions before measured samples. Cold editor work uses fresh service instances. Sub-millisecond cache-hit and cancellation paths batch operations inside each sample and report amortized per-operation latency so an operating-system scheduling pause is not misclassified as many slow operations.

Reports include minimum, mean, standard deviation, coefficient of variation, p50, p95, and maximum. A budget change requires a reviewed methodology, fixture, or supported-runtime justification.

## Cancellation

Language-service work checks cancellation before configuration, after schema loading, and after analysis. Workspace discovery checks between directory entries.

Grammar analysis is synchronous and bounded. Cancellation received during that section is observed immediately afterward. If valid workloads approach the published editor limits, analysis must gain a worker or cooperative asynchronous boundary before those limits are relaxed.
