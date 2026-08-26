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
- correlated and independent conditional structure;
- rejecting structural expansion before grammar work exceeds its bound;
- core fragment composition and rendering;
- cold, unchanged, incrementally edited, and schema-reloaded language-service analysis;
- cancellation before expensive analysis;
- retained heap under cache pressure.

The structural scenarios assert their analysis counts as well as their timing. A fast but incorrect implementation does not pass.

## Latency budgets

| Scenario | p50 | p95 |
| --- | ---: | ---: |
| Scanner, 1,000 queries | 10 ms | 25 ms |
| Compiler, 250 PostgreSQL queries | 20 ms | 50 ms |
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
