# Repository topology and tracked-line accounting

The [JSON inventory](./repository-measurements.json) measures `eab41d13786c985ed5b5afeeb078e9041adcab2e` against PR base `3753571154bb3acf460a2a2031e9b20f88e21ea8` and exhaustive proposal `e194abb4f55523f435995a74d7d8ab58c2c42977`. Physical UTF-8 lines include comments and blanks. They are not semantic statements, maintenance effort, installed payload or bundle bytes.

The direction change removes **336,469 tracked text lines** relative to the exhaustive proposal. Captured vendor catalog JSON is absent. That proposal's +486,674 / −67,823 diff is reproduced independently by Git numstat. At this source pin the replacement diff is **+99,566 / −17,184**.

| Tracked content | PR base | Exhaustive proposal | Current | Current − base |
| --- | --- | --- | --- | --- |
| All tracked text | 457,258 | 876,109 | 539,640 | +82,382 |
| Maintained package source | 91,944 | 99,619 | 107,223 | +15,279 |
| Generated package source | 23,439 | 0 | 29,163 | +5,724 |
| Tests / E2E source | 88,353 | 101,778 | 111,071 | +22,718 |
| Tooling source | 9,007 | 17,479 | 11,095 | +2,088 |
| Other source, including planning tools | 15,833 | 16,310 | 19,063 | +3,230 |
| Captured vendor catalog JSON | 0 | 175,882 | 0 | +0 |
| Other audit / fixture / report data | 105,432 | 335,870 | 131,218 | +25,786 |
| Documentation | 21,435 | 27,000 | 27,876 | +6,441 |

Maintained package source grows by 15,279 lines; generated package source grows by 5,724. The total includes restored baseline catalogs plus compact vocabulary/codec projections, not a new exhaustive function corpus. Tests and retained audit metadata are separate categories. Existing generated example schemas contribute 4,082 lines in every compared revision.

## Package source ownership

| Package | Maintained lines | Maintained Δ | Generated lines | Generated Δ |
| --- | --- | --- | --- | --- |
| `analysis` | 5,786 | +5,786 | 0 | +0 |
| `build` | 1,608 | +286 | 0 | +0 |
| `cli` | 3,347 | +864 | 0 | +0 |
| `compiler` | 8,661 | +672 | 0 | +0 |
| `config` | 285 | +114 | 0 | +0 |
| `core` | 6,276 | +170 | 0 | +0 |
| `duckdb` | 8,831 | +1,130 | 14,242 | +2,989 |
| `language-server` | 2,854 | +461 | 0 | +0 |
| `mysql` | 11,589 | +1,565 | 1,054 | +1,030 |
| `postgres` | 20,031 | +2,181 | 13,363 | +1,201 |
| `sqlite` | 8,806 | +788 | 284 | +284 |
| `sqlserver` | 10,506 | +1,262 | 220 | +220 |

A generated header must occur in the leading comment preamble; mixed generated blocks inside maintained files are not separated. Package counts include optional development/native paths and do not imply those paths enter application bundles. Complete category totals, binary bytes, largest inputs and independent Git diff reconciliation remain in JSON.

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
  mysql/src/analysis/<series>   selected full analyzers
  mysql/src/analysis/core/      selected cores retaining maintained families
  postgres/src/analysis/<major> selected full analyzers
  postgres/src/analysis/core/   selected cores retaining maintained families
  postgres/src/catalog/provider.ts  immutable catalog ownership
  postgres/src/type-resolution-factory.ts  catalog-owned type/operator caches
  postgres/src/project-catalog*  selected reusable routine interpretation
  sqlite/src/analysis/core.ts   maintained rules with explicit long-tail generation
  sqlserver/src/analysis/core.ts  maintained rules with explicit long-tail generation
scripts/language-audit/         independent discovery and reviewed drift detection
planning/hybrid-analysis/       design, qualification evidence and measurement tools
packages/*/test/ + test/ + e2e/ ownership, conformance and installed-consumer checks
```

Each grammar also owns compact source-derived vocabulary under `src/vocabulary/`; its pure compatibility identity stays outside the vocabulary dependency graph. Pinned source facts/locks and qualification deltas live under `grammar/<grammar>/`. Ordinary builds use checked-in facts and do not fetch vendor sources. Metadata discovery and native qualification remain independent from the maintained semantic rules.

## Reproduction

```sh
node planning/hybrid-analysis/measure-repository.mjs HEAD planning/hybrid-analysis/repository-measurements.json
node planning/hybrid-analysis/render-measurements.mjs
```

The collector reads exact Git trees/blobs, excluding build output and installed files. The revision pin avoids treating later edits to these measurement reports as measured source. This is current accounting, not a prediction for unfinished work. See [bundle/install costs](./bundle-size.md), [project costs](./project-size.md) and the [acceptance audit](./acceptance-audit.md).
