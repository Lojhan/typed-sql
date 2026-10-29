# Fresh JSON parsing experiment

This isolated experiment follows the merged JSON callback-allocation change. It changes validation
only for JSON text parsed inside the core helper, without a reviver. Such a parse creates dense,
acyclic arrays and data-only objects, so the value pass can avoid cycle tracking, prototype tests
and object-member snapshot arrays. The general validator still handles caller/driver-owned objects,
including getter evaluation order, sparse arrays, cycles and custom prototypes. Both routes retain
finite-number policy, depth/value-count limits and the complete existing shape-validation pass.
No application-facing API or dependency changes.

`before.json` measures clean `a447c636b56f594f95a3e9a6fc9676f1c9435ff5`; its production files are
identical to merged main `e4da3c4565565bfc9299da6b62572ff3d280900a`. `after.json` records that main
commit plus the experimental patch. The SHA-256 of `git diff HEAD -- packages/core/src/json.ts
packages/core/src/query-value-plan.ts packages/core/test/json.test.ts` is
`378b2eb9b7c1262232e729e748e6b8fe27a28fc1ec91e34ac1872720d7f58631`.
Reports retain the working-tree diff hash, source identity,
environment, methodology and every raw batch-average sample. `summary.json` derives medians.
The harness is `../../src/runtime.mjs`.

Matched-host measurements use Apple M3 Pro / macOS, Node 24.11.1 / SQLite 3.50.4 and pinned
Reylo 0.6.0. Each stage uses three trials, deterministically shuffled candidate order, 12 samples
of 1,500 calls, 500 warm-ups, and separate processes/fixtures for each case. Fixtures compile
outside the timed operation. All candidates' result values are verified before and after warm
measurement. Concurrency 8 means queued logical calls on one synchronous SQLite connection,
not parallel database I/O. These are batch-average latencies, not individual request-tail values.

| Concurrency 1, median microseconds | Before | After |
| --- | ---: | ---: |
| Raw cached, JSON | 12.62 | 12.58 |
| Reylo SQL file, JSON | 13.96 | 13.83 |
| typed-sql compiled, JSON | 25.76 | 24.28 |
| typed-sql parsed-policy SQL file, JSON | 23.64 | 21.85 |
| typed-sql compiled, point | 6.60 | 6.59 |
| typed-sql compiled, 32 rows | 21.46 | 21.47 |

JSON latency falls approximately 5.8% / 7.6% for the two typed candidates at concurrency 1,
and 6.3% / 7.9% at concurrency 8. Raw/Reylo JSON controls change by less than 1% at concurrency 1,
and approximately 2% at concurrency 8. Non-JSON 32-row typed results are nearly unchanged.
These measurements support a modest workload-specific improvement, not closing the Reylo gap
or a general database performance guarantee. No PostgreSQL/MySQL timings or allocation profiles
were collected in this experiment.

The compiled candidate retains its text JSON policy and parses again in the application-side
benchmark normalization; the parsed-policy candidate returns validated objects directly. Compare
each candidate against its own baseline rather than attributing their difference solely to this
patch. Existing result/parameter decoding tests plus direct differential checks exercise both paths.
Boundary checks cover 128 versus 129 levels and 1,000,000 versus 1,000,001 visited JSON values.
