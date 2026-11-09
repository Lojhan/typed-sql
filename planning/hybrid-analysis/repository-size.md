# Repository topology and tracked-line accounting

The [machine-readable inventory](./repository-measurements.json) measures committed source
`1adfc8e5ded500d509ae47c10c8d971a7c78e6b0` against PR base `3753571154bb3acf460a2a2031e9b20f88e21ea8` and the exact
`e194abb4f55523f435995a74d7d8ab58c2c42977` proposal that produced +486,674 / −67,823.
These are physical UTF-8 lines, including comments and blanks. They are not semantic statements,
maintenance effort, bundle bytes or an estimate of the unfinished architecture.

## What the direction change removes

The current source has **373,476 fewer tracked text lines** than the exhaustive proposal.
That proposal's five `grammar/*/facts/catalog.json` files contribute 175,882 lines / 24,929,359
bytes and are absent now. Its separate `grammar/catalog/upstream.json` has another 165,165 lines
and is also absent. Other audit/fixture/report data falls by 225,717 lines overall, including
that upstream registry. Required reviewed reference/native-audit fixtures remain.

Most of the original giant addition was captured data and reports, rather than committed
TypeScript. Build-emitted code is outside this inventory. Restoring the pre-existing offline
catalogs means generated package source is present again; that is compatible behavior retained
from the PR base, not a new exhaustive generated pipeline.

| Tracked content | PR base | Exhaustive proposal | Current source | Current minus base |
| --- | ---: | ---: | ---: | ---: |
| Tracked physical text lines | 457,258 | 876,109 | 502,633 | +45,375 |
| Maintained package source | 91,944 | 99,619 | 105,725 | +13,781 |
| Generated package source | 23,439 | 0 | 26,154 | +2,715 |
| Maintained test/E2E source | 88,353 | 101,778 | 106,408 | +18,055 |
| Captured vendor catalog JSON | 0 | 175,882 | 0 | +0 |
| Other audit/fixture/report data | 105,432 | 335,870 | 110,153 | +4,721 |

Maintained package source grows by **13,781 lines** over the base; maintained tests/E2E grow by
**18,055 lines**. Generated package source grows by **2,715 lines**. Existing generated example
schema inputs add another 4,082 lines in every compared revision. Keeping these categories
separate avoids calling tests, captured metadata or retained baseline catalogs newly generated
application code. The complete inventory also accounts for tooling, application/editor/website
source, other source, documentation, configuration/data, other text and binary bytes.

## Package source ownership

These rows include every package with changed maintained source or current generated source.
The JSON report also retains unchanged package totals. A generated header must appear in the
leading comment preamble; ordinary comments discussing generation do not classify a file as
generated. Mixed generated blocks inside maintained files are not split.

| Package | Maintained lines | Maintained delta from base | Generated lines | Generated delta from base |
| --- | ---: | ---: | ---: | ---: |
| `analysis` | 5,760 | +5,760 | 0 | +0 |
| `build` | 1,608 | +286 | 0 | +0 |
| `cli` | 3,347 | +864 | 0 | +0 |
| `compiler` | 8,661 | +672 | 0 | +0 |
| `config` | 285 | +114 | 0 | +0 |
| `core` | 6,276 | +170 | 0 | +0 |
| `duckdb` | 8,729 | +1,028 | 13,309 | +2,056 |
| `language-server` | 2,854 | +461 | 0 | +0 |
| `mysql` | 11,146 | +1,122 | 179 | +155 |
| `postgres` | 19,470 | +1,620 | 12,666 | +504 |
| `sqlite` | 8,588 | +570 | 0 | +0 |
| `sqlserver` | 10,358 | +1,114 | 0 | +0 |

`analysis` owns shared contracts, evidence, cache lifecycle and orchestration. Grammar packages
own interpretation, native admission and codecs. Host packages consume prepared views and
contracts. Source counts include whole packages, including optional development/native paths;
they do not imply those paths enter application bundles.

## Current topology

```text
packages/
  core/src/                    neutral query, runtime plan and shared resolver contracts
  schema/src/                  snapshots, codecs and canonical serialization
  analysis/src/                contracts, qualification, durable artifacts and local cache
                               project catalogs, live acquisition and immutable views
  config/src/                  explicit host configuration
  compiler/src/                extraction, contract consumption and declaration emission
  cli/src/                     generation, export, refresh and checking
  build/src/                   synchronous build integration over prepared inputs
  language-server/src/         opted-in asynchronous editor orchestration
  ts-bridge/src/               isolated preview integration
  <grammar>/src/
    query.ts / profile.ts      lightweight query and type-policy boundaries
    runtime.ts                 execution and decoding
    analysis.ts / resolver*    offline syntax and semantics
    contract-profile.ts        grammar-owned contract identity
    reconciliation.ts          independent native/static comparison
    <driver adapter>*          optional introspection/acquisition/execution
    catalog/ / codecs/         retained offline facts and compact codec projections
  duckdb/src/analysis/core/     exact-engine compact analyzers
  duckdb/src/analysis/packs/    explicit engine compatibility packs
  duckdb/src/catalog/core/     generated selected overloads and shared type mechanics
  duckdb/src/catalog/packs/    complementary generated overloads
  postgres/src/project-catalog*  selected reusable routine interpretation
scripts/language-audit/         independent discovery and reviewed drift detection
planning/hybrid-analysis/       design, qualification evidence and measurement tools
packages/*/test/ + test/ + e2e/ ownership, conformance and installed-consumer checks
```

Snapshot/schema files and durable query contracts are compiler inputs. Disposable `.typed-sql`
state is local cache data. Per-query value plans enter used application queries where decoding
needs them. No global audit corpus is required during normal builds or application execution.
The [project-size report](./project-size.md), [bundle report](./bundle-size.md) and installation
measurements quantify those separate costs.

## Remaining target topology

DuckDB now has explicit core/pack modules, immutable installed-pack identities and exact-engine
selection. Its core and optional signature partitions reconstruct the original native rows and
ordering exactly; signatures and casts are not copied into a second full vendor catalog. The
native data digests remain unchanged. The generated source increase includes the compact
builtin-name vocabulary needed for binding/shadowing checks, selection metadata and provenance.
The commit moves existing generated rows, so added/deleted diff counts exceed the net growth.

Other grammars still need appropriate core/pack and version-selection boundaries. Representative
workload selection, reusable catalog/custom-type interpretation beyond PostgreSQL and qualified
selection merging remain open. This accounting is not the final LOC result for those unfinished
parts. [The bundle report](./bundle-size.md) measures the current DuckDB distribution separately.

The measured prototype establishes the maintenance cost and removed corpus. It does not justify
an invented numerical prediction for the remaining core/pack implementation. Later measurements
can repeat the same exact-reference comparison after that work lands.

## Reproduction and validation

Use a clone containing all three named commits; the tool performs no fetch or source mutation:

```sh
node planning/hybrid-analysis/measure-repository.mjs HEAD planning/hybrid-analysis/repository-measurements.json
```

The tool reads Git trees/blobs rather than working files, excludes binary content from line counts,
records classifier/source identities and lists the largest generated sources and data files.
All tracked-file/category/package sums agree. For all three comparisons, independent Git numstat
additions minus deletions equal the physical text-line delta. The original proposal reproduces
+486,674 / −67,823 exactly. Scope/classification details and binary file/byte counts remain in JSON.
