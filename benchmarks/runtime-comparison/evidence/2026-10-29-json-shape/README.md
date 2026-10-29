# JSON shape traversal measurements

These reports record a matched-host SQLite experiment on Apple M3 Pro, macOS, Node 24.11.1
(SQLite 3.50.4), against pinned Reylo 0.6.0. They are measurements, not performance guarantees.
The canonical harness is `../../src/runtime.mjs`. Every report retains its source identity,
environment and raw batch-average samples. `summary.json` derives medians and sampled allocation
attribution from those reports and the compressed raw V8 heap profiles alongside them.

The baseline is commit `8d24069b1fbbb3a254caa00925abca59dcbd35b8`. Its JSON validator, query-value
runtime and SQLite runtime are identical to main `0875667b09275f3113484ca75d291557d532ded2`.
The after reports use main plus the JSON traversal patch, whose `git diff HEAD --
packages/core/src/json.ts` SHA-256 is
`adde0a2109943a911f133faef0cf2d8cc5948e911ada5c2fda937e154a7b08d9`.
The change replaces array/tuple/union callbacks with loops. The general JSON-value validation pass,
shape checks, short-circuit order, depth and value-count limits remain in place. Loop lengths are
captured and absent indices skipped as in the previous array methods; the preceding value pass
continues to reject sparse input arrays.

Ordinary timing uses three trials, 12 samples of 1,500 calls and 500 warm-up calls per case,
with deterministically shuffled candidates. Cases run in separate processes. Concurrency 8 means
queued logical calls on one synchronous SQLite connection, not parallel database I/O. The before
run additionally includes prepared and text-policy SQL-file candidates. Compare only common
candidates between stages. Generated fixtures are compiled outside timed operations; results are
checked before and after warm timing. JSON text is parsed inside timing wherever an object result
is needed for comparison. The parsed-policy SQL-file candidate directly returns validated objects;
the default text-policy compiled candidate retains its text contract and needs an application parse.

| Concurrency 1, median microseconds | Before | After |
| --- | ---: | ---: |
| Raw cached, JSON | 12.54 | 12.72 |
| Reylo SQL file, JSON | 13.67 | 14.12 |
| typed-sql compiled, JSON | 25.93 | 25.79 |
| typed-sql parsed-policy SQL file, JSON | 22.98 | 23.65 |

The timing changes are small alongside control drift and do not establish a latency improvement.
The JSON gap against Reylo remains material. Batch-average medians and percentiles are not
individual request-tail latency.

Allocation sampling runs separately: one trial, five samples of 1,000 calls, 500 warm-ups,
concurrency 1, V8 sampling interval 4,096 bytes, including minor- and major-GC-collected objects.
Profiler timings must not be compared with ordinary timing runs. These values estimate total
allocated bytes, not retained heap or peak memory.

| JSON workload, sampled allocated MB per 5,000 calls | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Compiled inline, text policy | 132.954 | 97.680 | 26.5% |
| SQL file, parsed policy | 122.908 | 85.856 | 30.1% |

The shape matcher's approximately 36 MB of self allocations disappears from the top frames.
The narrower supported conclusion is reduced temporary allocation pressure, not faster SQL
execution. This experiment does not refresh PostgreSQL or MySQL latency measurements.
