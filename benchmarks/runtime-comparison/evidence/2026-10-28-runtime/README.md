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

## Repeated-plan metadata retention

`selector-retention.mjs` is a small reproduction for the bounded selector cache: one immutable
500-field JSON shape, 64 distinct INSERT cardinalities from 50 through 113, and one shared input
payload. Run it from the repository root with Node 24.11.1 and `--expose-gc --import tsx` on either
side of `98ef8c5`. It samples retained heap after explicit GC; it does not execute a database query
or measure invocation-value retention.

The original independent review observed 125,708,984 retained bytes before immutable shape reuse
and 537,744 afterward. `selector-retention.json` records the context and limits of this observation.
The optimization shares only core-normalized immutable shape identities and still charges every
logical node against each plan's expansion limit. Mutable caller objects remain copied on every
normalization; the package tests exercise both caller mutation and repeated-shape budget rejection.

## Final integrated platform

The `*-platform-final.json` reports measure clean commit `8ff007f`, whose production code is
`54af832`; the additional commit passes the existing schema snapshot to the benchmark's
SQL-mode-aware MySQL parameter tokenizer. Subsequent Miniflare development dependency patches
do not alter this runtime or these native driver versions. All runs use Node 24.11.1 on the
same Apple M3 Pro host: SQLite 3.50.4, PostgreSQL 18.6, and MySQL 8.4.13. Raw/Reylo and typed-sql
resolve the same pg 8.23.1 and mysql2 3.24.6 versions, checked before timing.

There are 540 ordinary observations: SQLite 216 and PostgreSQL/MySQL 162 each. Each engine has
three trials, both concurrency 1 and 8, and point/32-row/JSON workloads. Every observation retains
12 batch samples, with 1,500 calls per SQLite sample and 500 per network sample. Warm-up is
500 calls for SQLite and 200 for network engines. The SQLite run finished before the dependency
maintenance break; PostgreSQL and MySQL ran after a second explicit quiet-window clearance.
No other agent builds or native proof workloads ran during these measurements.

`final-timing-summary.json` derives medians and p95 batch averages from all retained samples,
plus per-case startup, first-call and fixture-build medians. It does not estimate individual
request tail latency. All generated factories are actually executed and checked for attached
runtime plans; every workload validates returned values before and after warm measurements.

The following are C1 median microseconds per operation, expressed as point / 32 rows / JSON:

| Engine | Raw cached | Reylo SQL file | Unplanned inline | Compiled inline with guards | SQL file with guards |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQLite | 4.33 / 12.14 / 12.81 | 5.46 / 17.83 / 14.33 | 6.14 / 17.78 / 15.21 | 6.83 / 22.88 / 26.22 | 7.72 / 22.51 / 27.43 |
| PostgreSQL | 37.08 / 50.89 / 85.86 | 48.07 / 66.85 / 103.50 | 49.91 / 67.16 / 105.97 | 50.04 / 72.22 / 116.89 | 51.42 / 74.54 / 119.06 |
| MySQL | 44.97 / 61.58 / 78.76 | 48.64 / 65.97 / 84.20 | 50.17 / 68.62 / 85.24 | 49.60 / 72.14 / 94.95 | 51.89 / 72.88 / 96.26 |

These results do not establish that typed-sql is faster than Reylo. Runtime parameter/result
validation adds measurable work, especially SQLite's 32-row and JSON paths. SQLite's parsed-policy
SQL file avoids the second application JSON parse and records 23.53 µs for JSON, versus 27.43 µs
under the original text policy. These policies have different application return contracts.
Prepared factories are separate candidates in the raw reports: PostgreSQL prepared compiled
queries measure 43.53 / 61.66 / 106.47 µs, whereas MySQL prepared compiled queries measure
51.25 / 73.17 / 94.74 µs. Preparation does not imply a universal improvement.

For C8, the following are batch-average microseconds per operation, with the same workload order:

| Engine | Raw cached | Reylo SQL file | Compiled inline with guards | SQL file with guards |
| --- | ---: | ---: | ---: | ---: |
| SQLite | 4.34 / 12.45 / 12.82 | 5.59 / 18.08 / 14.51 | 6.48 / 21.67 / 26.36 | 7.74 / 22.47 / 26.60 |
| PostgreSQL | 14.78 / 22.88 / 25.67 | 16.81 / 26.03 / 29.68 | 18.09 / 31.67 / 39.22 | 18.95 / 32.41 / 40.01 |
| MySQL | 15.79 / 21.41 / 25.09 | 18.27 / 24.32 / 28.59 | 20.16 / 30.79 / 39.48 | 20.57 / 31.46 / 41.29 |

SQLite C8 schedules logical calls over one synchronous connection; it does not provide parallel
SQLite I/O. Network C8 uses pools with up to ten physical connections. Typed-sql retains its
transaction/stream ownership queue; Reylo's SQLite executor delegates directly to its supplied
driver. This comparison preserves those different guarantees rather than removing safety work.

Cold process-to-first-result point medians (ms) are Reylo / compiled inline / SQL file:
SQLite 96.4 / 64.5 / 101.9; PostgreSQL 153.3 / 82.6 / 141.4; MySQL 151.1 / 94.6 / 133.5.
Compiled factories have already been transformed; their separate fixture/build medians are
3.5, 7.1 and 2.1 ms respectively, with every raw fixture-build sample retained. Compiler imports
are cached within the benchmark coordinator, so these build medians do not promise a fresh
compiler process startup time. Typed-sql SQL files analyze an offline snapshot during loading;
Reylo SQL files use live schema analysis. Filesystem caches are not flushed.

Against the earlier Node 24.11 baseline, SQLite guarded SQL-file C1 medians change from
6.34 / 18.20 / 15.20 to 7.72 / 22.51 / 27.43 µs. Its old SQL-file path did not enforce the new
runtime shape contracts. Raw and Reylo controls also drift by roughly 3–12%, but that does not
explain away the JSON guard cost. Network baseline-to-final medians generally fall while their
raw/Reylo controls also improve roughly 7–16%; this host/run drift prevents attributing those
network improvements to production changes. Use the isolated allocation experiments above for
optimization claims and the final same-run tables for frontend comparisons.

## Final profiles and cleanup

`*-platform-final-{alloc,cpu}.json` preserve six additional profiling runs, covering actual
compiled inline and SQL-file paths for all three workloads and engines. Allocation sampling uses
5,000 calls per case; CPU sampling uses 50,000. These 36 compressed V8 profiles are indexed with
uncompressed SHA-256 digests in `profiles.json`; `final-profile-summary.json` records allocations
and the largest self frames. Instrumented timings are excluded from the ordinary results above.

Sampled allocated bytes per call (point / 32 rows / JSON) are:

| Engine | Compiled inline | SQL file |
| --- | ---: | ---: |
| SQLite | 7,207 / 31,057 / 27,108 | 8,484 / 32,091 / 28,462 |
| PostgreSQL | 17,101 / 34,049 / 33,939 | 18,087 / 35,508 / 35,030 |
| MySQL | 17,666 / 31,429 / 35,062 | 18,825 / 32,464 / 36,449 |

SQLite's native `all`, result-row copying and per-row decoding remain material in multirow CPU
samples. JSON decoding, finite-value/shape checks, and the extra text-policy application parse
remain visible. Network profiles mostly sample idle socket/server wait; among active frames,
JSON decoding/validation and mysql2's captured error stacks contribute work. Idle samples are not
CPU utilization. No driver error-stack setting, transaction ordering, validation guard, or resource
limit was removed to improve these results.

Owned PostgreSQL clusters were stopped and temporary directories removed after every run.
`native-server-cleanup.json` records the final graceful shutdown of the isolated MySQL server,
verified process identity/exit, closed port and removed temporary data directory. Other projects'
VMs and global database installations were untouched.
