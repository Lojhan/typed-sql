# Commerce project size and growth

The [JSON report](./project-measurements.json) measures `eae1274d8debd90af9c4b2ffa1ab8cbd1e3227bd` with Node v24.22.2 and esbuild 0.28.2. It discovers every ledger grammar, maintained commerce query file and matching public core export. There is no benchmark function-name list or copied vendor corpus. Schema inputs come from the example DDL parser, not live introspection.

## Selected-core coverage

All **37 finite candidate analyses** are identical between selected cores and compatibility analyzers, including columns, ordered parameters, diagnostics and semantic facts. Every TypeScript module still compiles. Runtime-sized rendering stays explicit and is excluded from exact contracts. These are curated example profiles, not production popularity or proof for arbitrary SQL.

| Grammar | Selected core | Example version | Exact candidates | Known codecs |
| --- | --- | --- | --- | --- |
| duckdb | `@typed-sql/duckdb/analysis/core/2.0.0` | 2.0.0 | 8 | 8 |
| mysql | `@typed-sql/mysql/analysis/core/9.7` | 9.7.0 | 7 | 7 |
| postgres | `@typed-sql/postgres/analysis/core/18` | 18 | 7 | 7 |
| sqlite | `@typed-sql/sqlite/analysis/core` | 3.54.1 | 7 | 7 |
| sqlserver | `@typed-sql/sqlserver/analysis/core` | 17 | 8 | 8 |

Known codecs establish modeled representations, not full nullability, JSON shape, precision or acceptance. Contracts below have `offline-rule` provenance; no native qualification is manufactured. SQL assets contribute artifacts but are omitted from runtime template bundles.

## Used runtime output

| Grammar | Renderer only KiB / gzip | With value plans KiB / gzip | One module through barrel KiB / gzip |
| --- | --- | --- | --- |
| duckdb | 19.0 / 6.2 | 28.6 / 8.3 | 18.5 / 6.0 |
| mysql | 19.1 / 6.3 | 27.9 / 8.3 | 18.3 / 5.9 |
| postgres | 19.3 / 6.3 | 28.8 / 8.4 | 18.2 / 5.8 |
| sqlite | 19.3 / 6.3 | 28.4 / 8.2 | 18.2 / 5.8 |
| sqlserver | 19.0 / 6.2 | 29.0 / 8.2 | 18.7 / 6.0 |

The tool rejects schema snapshots, durable envelopes, global analyzer catalogs and native acquisition modules in these runtime graphs. Selecting one module through a barrel retains exactly one application module, with the same minified byte count at all measured scales. Compressed sizes/digests can vary slightly with minifier naming. Required renderer/value-plan/codec bytes remain.

## Synthetic exact-query growth

Copies add SQL comments to create distinct exact identities; they do not add business features. The largest measured scale is:

| Grammar | Copies | Contracts | Durable file KiB | Framed closure gzip KiB | Standalone plan KiB |
| --- | --- | --- | --- | --- | --- |
| duckdb | 50 | 400 | 687.7 | 57.2 | 316.2 |
| mysql | 50 | 350 | 531.0 | 46.8 | 216.9 |
| postgres | 50 | 350 | 569.9 | 47.6 | 246.3 |
| sqlite | 50 | 350 | 557.5 | 47.3 | 234.6 |
| sqlserver | 50 | 400 | 638.4 | 53.8 | 268.9 |

Closure compression uses sorted name/NUL/length/NUL/content framing; it is not a tarball or installation size. Standalone plan JSON is measured separately and is not another mandatory artifact. These offline-rule sizes exclude native descriptor/reconciliation overhead. The [native commerce report](./native-projects.md) separately measures actual qualified subsets and failed/unsupported classes across all five grammars; it does not establish complete native application support.

## Schema-input growth

| Grammar | Relations / KiB at each scale |
| --- | --- |
| duckdb | 7 / 12.3; 57 / 186.7; 507 / 1757.2 |
| mysql | 7 / 10.9; 57 / 99.6; 507 / 898.9 |
| postgres | 7 / 11.3; 57 / 98.5; 507 / 885.1 |
| sqlite | 7 / 10.2; 57 / 99.1; 507 / 900.1 |
| sqlserver | 7 / 10.7; 57 / 113.2; 507 / 1036.4 |

This experiment adds unused product-shaped relations and validates the resulting snapshot. It isolates serialization growth, rather than pretending to model independently designed business tables or a complete native catalog.

## Reproduction

```sh
pnpm build
node --import tsx planning/hybrid-analysis/measure-projects.mjs
node planning/hybrid-analysis/render-measurements.mjs
```

Use clean library/corpus sources at the named revision. The collector exports and reopens real artifacts in an owned temporary directory, checks contract counts and runtime dependency graphs, records source/tool/lockfile/corpus identities and removes temporary files. It measures bytes, not latency. Installation, native evidence, production workload selection and full architecture acceptance remain distinct concerns.
