# Bundle measurements and remaining boundaries

The [machine-readable report](./bundle-measurements.json) measures committed source at
`ab69557c7704635e92c8653cc47d444c2674fdbf`, compared with the earlier exhaustive-catalog revision
`a1f27fc894e48021e91ce4c9a4b98929890f233d`. Both use the same measurement tool, esbuild 0.28.2,
Node 24.22.2, minified ESM, Node platform, ES2022, tree-shaking, gzip level 9 and Brotli quality 11.

## Analyzer comparison

All sizes are KiB (1,024 bytes). These are complete grammar-factory exports, retaining dynamic
version selection. They exclude a TypeScript project, driver implementation and database engine.

| Grammar | Earlier analyzer minified | Current analyzer minified | Earlier gzip | Current gzip |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 1,649.9 | 382.4 | 131.8 | 67.7 |
| MySQL | 180.6 | 183.4 | 43.2 | 44.0 |
| SQLite | 154.7 | 148.7 | 39.5 | 39.4 |
| SQL Server | 138.7 | 121.1 | 35.6 | 34.6 |
| DuckDB | 1,340.3 | 625.8 | 101.4 | 75.2 |

This measures the net change between those revisions, including removal of the exhaustive
pipeline, maintained semantic corrections and API separation. It does not isolate savings caused
by query contracts. In particular, MySQL grows slightly. Maintained global semantics and version
tables still contribute to analyzers; workload-selected core/pack distribution remains unmeasured.

## Current consumer graphs

| Grammar | Root query tag minified / gzip | Profile minified / gzip | Frozen host helpers minified / gzip |
| --- | ---: | ---: | ---: |
| PostgreSQL | 17.1 / 5.4 | 43.7 / 12.1 | 124.5 / 35.9 |
| MySQL | 17.1 / 5.4 | 47.1 / 13.2 | 128.0 / 37.0 |
| SQLite | 17.1 / 5.4 | 49.5 / 13.3 | 130.3 / 37.2 |
| SQL Server | 17.1 / 5.4 | 43.4 / 12.1 | 124.1 / 35.9 |
| DuckDB | 17.1 / 5.4 | 63.0 / 17.8 | 143.9 / 41.2 |

Root tags, `/query` tags, profiles and frozen hosts contain zero global grammar catalog inputs
in these measurements. Frozen hosts export `createContractDialect`, `loadQueryContracts`,
`compileSource` and a grammar profile. They include compiler/contract loading work absent from
the analyzer-only sample, so subtracting those columns is not an equal-functionality comparison.
SQL Server's frozen helper sample is slightly larger than its analyzer-only sample.

Ordinary query tags already had no large generated catalog in the earlier measurement. The
main isolation benefit is contract-only compilation without the global analyzer, rather than
another megabyte-scale production tag reduction. Runtime value plans and compact codec/type
facts remain necessary. Unbundled module isolation is separately exercised by the packed
consumer test, which removes semantic catalogs and development entrypoints before imports.

## Reproduction

Run from an installed repository with Node 24.22.2:

```sh
node planning/hybrid-analysis/measure-bundles.mjs a1f27fc894e48021e91ce4c9a4b98929890f233d /tmp/typed-sql-bundle-baseline.json
node planning/hybrid-analysis/measure-bundles.mjs ab69557c7704635e92c8653cc47d444c2674fdbf planning/hybrid-analysis/bundle-measurements.json /tmp/typed-sql-bundle-baseline.json
```

The tool discovers grammars from the committed feature ledger and public entrypoints from package
exports. Workspace contents come from Git blobs at the named revision, including files absent
from the current worktree. It honors `sideEffects: false` and never substitutes empty catalogs.
The baseline has four public scenarios per grammar; the current revision adds profile/frozen
scenarios. The report includes byte counts, output digests, source/lockfile/tool hashes, input
attribution and whole-output compression. Generated attribution counts explicit generation
headers. Input contributions are minified bytes, not proportional compressed savings.

These are synthetic source graphs, not a representative application corpus. Package installation
sizes, migration-derived project contracts, schema/value-plan growth and a realistic workload
corpus remain required measurements. The report does not claim those acceptance requirements
are complete.
