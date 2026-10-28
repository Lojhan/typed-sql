# Runtime measurements, 28 October 2026

These files preserve the raw samples and V8 profiles from one Apple M3 Pro macOS host. They are
an experiment on the named commits, drivers and Node versions, not a performance guarantee.
The canonical harness is `src/runtime.mjs`; environment and source identities are inside each
report. Allocation and CPU sampling runs are separate from ordinary timing runs.

## SQLite row-copy optimization

The `sqlite-before*` reports use commit `a65c542`, before the runtime optimizations.
`sqlite-row-after*` uses `c997a06`, replacing the temporary entries/map/fromEntries chain with a
single property-copy loop. `sqlite-async-after*` uses `14655eb`, also removing redundant promises
around synchronous SQLite calls. All three stages used Node 24.10.0 and the same benchmark
settings. SQL-file loader support subsequently raised its minimum to Node 24.11.1; the 24.10
measurements remain historical evidence for these runtime changes.

Allocation sampling covered 5,000 calls per workload, with minor- and major-GC-collected objects
included. The values below are sampled allocated megabytes, not retained heap size.

| Workload | Before | Row-copy change | Also remove redundant promises |
| --- | ---: | ---: | ---: |
| Point lookup | 38.507 | 34.079 | 32.147 |
| 32 rows | 250.683 | 112.239 | 108.407 |
| JSON aggregate | 65.081 | 62.159 | 59.931 |

Before the row-copy change, `Object.entries`, the row mapping callback and `Object.fromEntries`
accounted for approximately 66% of sampled allocations in the 32-row workload. The replacement
reduced total sampled allocations by approximately 55%. Ordinary C1 sample medians improved
from 27.28 to 19.32 microseconds for inline queries and 27.16 to 18.83 for prepared queries.
The raw and Reylo controls were slower in that second run, so this improvement does not follow
from a faster host during the second measurement. Point and JSON latency did not show a
consistent improvement. The additional promise change reduced sampled allocations; its latency
change was too small and noisy to establish another speed improvement.

The CPU profiles locate the 32-row copy loop as a material cost. For JSON aggregation, database
execution and JSON parsing dominate instead. Consequently the optimization preserves execution,
transaction and stream queues and changes only row copying and redundant promise creation.
The focused native-driver test covers BLOB conversion and own `__proto__`/`constructor` columns;
the full SQLite suite and coverage passed after both changes.

## Before-platform baseline on Node 24.11.1

`sqlite-node2411-before-platform.json` and `postgres-node2411-before-platform.json` use the
optimized existing runtime, before the new metadata-backed frontend and adapter changes.
They preserve three trials, concurrency 1 and 8, three workloads, all candidate paths, cold process
startup and first API-call measurements. The PostgreSQL run used a dedicated local server with
an isolated temporary data directory, stopped and removed afterward. The exact database version
is recorded in the report. These are baseline measurements; they do not establish the performance
of the completed metadata-backed frontend.

`sqlite-node2411-before-platform-alloc.json` separately profiles typed prepared and SQL-file
paths. SQL-file static-fragment construction was an allocation candidate; its final effect must
be measured after metadata generation and fragment hoisting are both integrated.

## Reading the artifacts

Each JSON report retains every batch-average duration. Compute medians or percentiles over those
samples; a batch-average p95 is not an individual request-tail percentile. Startup includes loader
imports and analysis; filesystem caches were not flushed. Heap-used deltas are retained-heap
noise. Profiler-instrumented durations must not be compared with ordinary timing runs.

The directories named after profile reports contain gzip-compressed, unmodified `.cpuprofile`
and `.heapprofile` files. Decompress them before opening in DevTools. `profiles.json` maps each
file to its originating report and records the SHA-256 of the uncompressed bytes. Original
absolute temporary profile paths remain in the reports as provenance; the mapped compressed
files are the durable copies. Driver URLs and credentials are not stored in the reports.
