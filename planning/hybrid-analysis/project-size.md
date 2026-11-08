# Commerce project size and growth

The [machine-readable report](./project-measurements.json) measures source revision
`4f19d94701cb58123681d5804e23bd424d3807d3` with Node 24.22.2 and esbuild 0.28.2. It discovers
all five grammars from the feature ledger and uses their maintained commerce example query files
and DDL. There is no copied vendor catalog or manually maintained benchmark function list.

The base workload covers account joins, product lookup, JSON documents, revenue aggregation,
audit writes, fixed inserts and runtime-sized inserts. SQL differs through each existing grammar's
example. The example DDL parser supplies conservative compiler inputs; these are not complete
live catalogs with every index/constraint or native-qualified contracts. This is a curated
application workload, not production telemetry or a popularity ranking.

## Base application bundles

All sizes below are KiB (1,024 bytes), minified / gzip. Both bundle columns retain every compilable
TypeScript query module, including the runtime-sized insert's selector plan. SQL assets contribute
to artifact measurements but are excluded from both runtime bundle columns. The plain column uses
original query tags; the plan column uses actual compiler-injected metadata. It is a feature-cost
comparison, not an earlier-release comparison. Reports also contain Brotli, input attribution,
module counts and output digests.

| Grammar | Renderer-only application | Application with value plans | One selected module through barrel |
| --- | ---: | ---: | ---: |
| PostgreSQL | 19.3 / 6.3 | 28.6 / 8.3 | 18.1 / 5.8 |
| MySQL | 19.1 / 6.3 | 27.8 / 8.3 | 18.3 / 5.9 |
| SQLite | 19.3 / 6.3 | 28.4 / 8.2 | 18.2 / 5.8 |
| SQL Server | 19.0 / 6.2 | 29.0 / 8.2 | 18.7 / 6.0 |
| DuckDB | 19.0 / 6.2 | 28.6 / 8.3 | 18.5 / 6.0 |

Plans add roughly 1.9–2.2 KiB gzip to this workload. Actual production bundles retain their used
renderer/value-plan/codec requirements. Schema snapshots, durable contract envelopes, native
adapters and global analysis catalogs are absent from these runtime graphs.

The selected-module bundle has the same minified byte count for 1, 10 and 50 workload copies in
every grammar, retaining exactly one application module. Output digests differ and compressed
sizes vary slightly; size stability does not imply byte-for-byte identical minifier output. Generated template constructors previously
kept unused static/conditional/repeated metadata alive. The new regression fails before the fix
and passes after compiler-side validation permits pure constructor annotations. Application
initialization effects remain observable. This complements the earlier SQL-file initializer fix.

## Exact artifacts and uncertainty

All TypeScript query modules compile for runtime metadata. The runtime-sized insert has no finite
exact-query rendering, so it is explicitly excluded from exact contracts while remaining in the
runtime bundle. The other source files contribute seven or eight exact candidates, depending on
the grammar's example. Exported/reopened artifacts have `offline-rule` provenance; no native
qualification or evidence is invented.

| Grammar | Exact candidates | Candidates with known codecs | Remaining modeled codec uncertainty |
| --- | ---: | ---: | --- |
| PostgreSQL | 7 | 5 | Enum-valued account/status/role fields |
| MySQL | 7 | 6 | Audit JSON input parameter |
| SQLite | 7 | 6 | Revenue SUM and threshold numeric family |
| SQL Server | 8 | 8 | None in these candidates |
| DuckDB | 8 | 8 | None in these candidates |

Known codecs establish the modeled representation, not complete nullability, JSON shape,
precision, acceptance or semantic coverage. JSON descriptors can establish a codec while retaining
an unknown shape; their scalar fallback may correctly remain `unknown`. Nested runtime types are
checked recursively. Per-file query digests and unresolved descriptor identities stay in the
report. These candidate counts are not percentages of grammar support.

## Synthetic growth, separate from the base workload

The 10/50-copy cases prepend SQL comments to create exact-text variants of the same workload.
They stress identity/artifact growth; they do not represent additional application features.
At 50 copies the measured artifact/plan payloads are:

| Grammar | Exact contracts | Durable file contents, KiB | Framed closure gzip, KiB | Standalone plan JSON, KiB |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 350 | 560.2 | 47.1 | 236.7 |
| MySQL | 350 | 526.8 | 46.8 | 212.7 |
| SQLite | 350 | 555.5 | 46.5 | 232.7 |
| SQL Server | 400 | 638.4 | 53.5 | 268.9 |
| DuckDB | 400 | 687.7 | 56.5 | 316.2 |

Closure compression uses sorted name/NUL/length/NUL/content framing, not a tarball or the sum of
individually compressed files. File-content sums exclude filesystem blocks and empty directories.
Standalone plan JSON repeats the plans; it is not an extra mandatory distributed artifact.
Native evidence and reconciliation add metadata absent from these offline-rule artifacts, so
these figures must not be presented as native artifact sizes.

A separate schema-input experiment adds 50/500 unused product-shaped relations, validated by the
owner. It measures serialization growth only; it does not pretend to be 500 independently
modeled business tables or a live-introspection payload:

| Grammar | Seven-relation schema, KiB | 57 relations, KiB | 507 relations, KiB |
| --- | ---: | ---: | ---: |
| PostgreSQL | 11.3 | 98.5 | 885.1 |
| MySQL | 10.9 | 99.6 | 898.9 |
| SQLite | 10.2 | 99.1 | 900.1 |
| SQL Server | 10.7 | 113.2 | 1036.4 |
| DuckDB | 12.3 | 186.7 | 1757.2 |

## Reproduction and boundaries

From a clean library/corpus checkout at the named revision, with repository-pinned dependencies:

```sh
pnpm build
node --import tsx planning/hybrid-analysis/measure-projects.mjs
```

The tool exports real artifacts into an owned temporary directory, reopens them and checks unique
contract counts. It asserts one retained application module in every selected-module graph and
rejects parser/catalog/native acquisition modules in runtime output. It records source/tool/
lockfile/corpus/input hashes, minified/gzip/Brotli sizes and attribution, then removes temporary
artifacts. It measures bytes, not acquisition latency or cache-hit performance.

The [public-entry comparison](./bundle-size.md) repeats the earlier analyzer/tag/profile/frozen
scenarios at the same revision. The published installation report remains pinned to its older
named revision; source bundles, installed payloads, compiler inputs and runtime plans are distinct
costs. Native-qualified project growth, production workload selection and full architecture
acceptance remain open.

## Verification

The regression and invalid-metadata checks pass with all 21 compiler test files and coverage.
Build-adapter, CLI, language-server, bridge, nine soundness files, public API/package graph and
three packed-consumer/editor suites pass, together with clean build/types, docs, quality and the
isolated performance gate. The PostgreSQL migration-derived disconnected frozen build passes.
[SQL Server run 42535227376](https://github.com/Lojhan/typed-sql/actions/runs/42535227376) passes
all four engine jobs at compiler commit `57e35256`, including installed table-query/editor/frozen
flows. Subsequent measurement commits change tooling/reports rather than compiler behavior.
