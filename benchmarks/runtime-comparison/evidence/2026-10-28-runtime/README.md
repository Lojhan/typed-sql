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

`sqlite-node2411-before-platform.json`, `postgres-node2411-before-platform.json` and
`mysql-node2411-before-platform.json` use the
optimized existing runtime, before the new metadata-backed frontend and adapter changes.
They preserve three trials, concurrency 1 and 8, three workloads, all candidate paths, cold process
startup and first API-call measurements. The PostgreSQL run used a dedicated local server with
an isolated temporary data directory, stopped and removed afterward. The exact database version
is recorded in the report. MySQL used a dedicated schema on an owned temporary native MySQL
8.4.13 server. `mysql-native-artifacts.json` records verified bottle digests and process isolation.
These are baseline measurements; they do not establish the performance
of the completed metadata-backed frontend.

`sqlite-node2411-before-platform-alloc.json` separately profiles typed prepared and SQL-file
paths. SQL-file static-fragment construction was an allocation candidate; its final effect must
be measured after metadata generation and fragment hoisting are both integrated.

## Corrected network driver baseline

The original `postgres-node2411-before-platform.json` and
`mysql-node2411-before-platform.json` used raw/Reylo driver versions 8.23.0/3.24.3 while the
linked typed-sql adapters resolved 8.23.1/3.24.6. Retain them as historical observations; do not
use their candidate ratios as a comparison with matching drivers.

The `*-node2411-corrected-before-platform.json` reports rerun the old production runtime with
matching drivers for every candidate: pg 8.23.1 and mysql2 3.24.6. Both raw and typed driver
versions are recorded and asserted equal before measurement. They retain three trials,
concurrency 1 and 8, six samples of 500 calls per case, and 200 warm-up calls. These corrected
reports provide the network baseline for the final platform comparison. The SQLite built-in
driver measurements are unaffected by this correction.

## Compiler and validator allocation profiles

The `sqlite-platform-*` reports execute real compiler-generated inline factories and the actual
SQL-file loader. Each allocation profile covers 5,000 calls. CPU profiles cover 50,000 calls in
separate processes. All use Node 24.11.1 and the same three workloads. The source commit and
working-tree patch hash are recorded in each report.

| Allocation profile, sampled MB | Before hoists | After hoists | Before validator loops | After validator loops |
| --- | ---: | ---: | ---: | ---: |
| Compiled inline, point | 49.284 | 35.516 | 35.749 | 36.052 |
| Compiled inline, 32 rows | 171.934 | 155.613 | 155.713 | 155.361 |
| Compiled inline, JSON | 268.984 | 223.387 | 222.606 | 134.507 |
| SQL file, point | 42.741 | 40.709 | 40.895 | 40.981 |
| SQL file, 32 rows | 163.522 | 160.702 | 161.505 | 160.165 |
| SQL file, JSON | 230.956 | 228.464 | 229.526 | 140.910 |

The first pair isolates compiler module-level plan preparation and SQL-file static-fragment
hoisting; each affects its own candidate. Compiled inline point allocations fell approximately
28%, and JSON allocations approximately 17%. The smaller SQL-file changes are close to the
sampling variation in other cases and do not establish a separate latency improvement.

The second pair includes the JSON-text overflow correction in both stages and isolates the
validator loops. JSON allocations fell approximately 39%, while point and non-JSON 32-row
controls remained nearly unchanged. Own-property, prototype, sparse-array, cycle, finite-value,
depth and value-count guards remain. Reading own JSON values still happens before recursive
validation so sibling getters cannot introduce a new finite-value false positive.

The post-loop allocation report was recorded immediately before commit `bfce526`; its patch hash
`080f391bea68c1deeea51d14db96f329bcd7477ea46d62657aedfa1ead6db97d` exactly matches
`git diff 6eebb56 bfce526 -- packages/core/src/json.ts packages/core/test/json.test.ts`.
The post-loop CPU report records the committed state. `platform-profile-summary.json` contains
derived per-call allocation estimates and top self-allocation/CPU frames; the compressed raw
profiles remain the source evidence. These profiler runs establish allocation and attribution
changes, not warm latency or final-platform performance claims.

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
