# Performance budgets

typed-sql treats responsiveness as a release contract. Package-local Poku tests catch obvious
algorithmic regressions quickly; the repository production gate then measures built JavaScript with
real grammar and language-service work.

The thresholds are regression limits, not promises that every application or machine will observe
the same latency. Every run prints its Node.js version, operating system, architecture, CPU model,
logical CPU count, total memory, CI status, and budget version beside the measurements.

## Run the gate

```sh
pnpm performance
```

`pnpm performance` creates production builds before measuring them. `pnpm verify` also builds and
runs the gate, so protected CI blocks a pull request that exceeds a failure threshold.

The versioned source of truth is [`performance-budgets.json`](../performance-budgets.json). Changes
to fixtures, sample counts, or limits are reviewed as code rather than hidden in a benchmark script
or CI environment.

## Methodology

Latency scenarios receive three warm-up executions followed by 20 measured executions. Cold editor
scenarios use 10 fresh-service samples. Reports include minimum, mean, standard deviation,
coefficient of variation, p50, p95, and maximum. CI emits a warning after a metric consumes 75% of
its budget and fails when p50 or p95 exceeds its configured ceiling.

Measurements use production files under each package's `dist` directory and cover:

- scanning one TypeScript file containing 1,000 static queries;
- compiling 250 queries with the PostgreSQL parser and resolver;
- 20 repeated correlated conditions, which must produce exactly two grammar analyses;
- six independent conditions, which must produce exactly 64 analyses;
- 20 independent conditions, which must stop before grammar analysis with `TSQ003`;
- core fragment composition and rendering in batches of 10,000 queries;
- cold, unchanged, incrementally edited, and schema-reloaded language-service analysis for a file
  containing 120 queries;
- cancellation before expensive analysis of a 2,000-query document;
- retained heap after 128 analyzed documents compete for a 32-entry cache.

The structural fixtures assert their analysis counts in addition to measuring time. A fast but
incorrect variant implementation therefore cannot pass.

## Version 1 failure budgets

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

Core composition and rendering must sustain a p50 of at least 250,000 operations per second. The
bounded editor cache may retain at most 16 MiB after garbage collection in the memory fixture.

These ceilings deliberately leave room for supported GitHub-hosted runners while remaining close
enough to measured work to catch order-of-magnitude regressions. Tightening or relaxing them
requires an updated budget version or a documented fixture/runtime justification.

## Cancellation and event-loop limits

Language-service requests check cancellation before configuration work, after schema loading, and
after analysis. Workspace discovery checks between directory entries. The performance fixture proves
that cancellation arriving during asynchronous setup aborts before the 2,000-query compile begins.

Grammar analysis itself is currently synchronous. A cancellation received during that bounded
section is observed immediately afterward, so the cold and incremental p95 ceilings are also the
responsiveness guard against monopolizing the editor process. We do not claim mid-parser
preemption. If valid workloads approach those ceilings, analysis should move behind a worker or
gain an asynchronous cooperative boundary before increasing the budgets.
