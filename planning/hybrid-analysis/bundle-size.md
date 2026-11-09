# Bundle and installation measurements

The [bundle JSON](./bundle-measurements.json) and [installation JSON](./installation-measurements.json) measure committed source `2e100286aee1853b30047721638437e843027a33`. Bundles compare against `a1f27fc894e48021e91ce4c9a4b98929890f233d` using the same tool, Node v24.22.2, esbuild 0.28.2, minified ESM, Node platform, ES2022, tree-shaking, gzip level 9 and Brotli quality 11. Sizes below use KiB (1,024 bytes) or MiB (1,048,576 bytes).

## Compatibility analyzers

These factory exports retain dynamic version selection and all existing maintained offline rules. Differences include source vocabulary, semantic fixes and package boundaries; they do not isolate savings attributable to contracts.

| Grammar | Earlier minified / gzip KiB | Current minified / gzip KiB |
| --- | --- | --- |
| duckdb | 1340.3 / 101.4 | 640.8 / 81.8 |
| mysql | 180.6 / 43.2 | 201.0 / 49.3 |
| postgres | 1649.9 / 131.8 | 415.8 / 74.7 |
| sqlite | 154.7 / 39.5 | 161.4 / 42.5 |
| sqlserver | 138.7 / 35.6 | 126.2 / 36.3 |

## Explicit analyzer selection

Selected cores request exact native query evidence for unmapped routines. PostgreSQL/MySQL cores retain their maintained families; DuckDB has complementary optional overload packs. SQLite/SQL Server each retain one maintained catalog with version/compatibility gates. These are measured distribution boundaries, not production popularity rankings.

| Grammar | Import scenario | Minified KiB | Gzip KiB | Generated retained input KiB |
| --- | --- | --- | --- | --- |
| duckdb | `analyzer:1.5.6` | 369.1 | 57.9 | 249.8 |
| duckdb | `analyzer:2.0.0` | 397.7 | 61.0 | 278.4 |
| duckdb | `analyzer:core:1.5.6` | 243.4 | 50.7 | 123.1 |
| duckdb | `analyzer:core:2.0.0` | 258.7 | 53.2 | 138.4 |
| duckdb | `analyzer:core:1.5.6:compatibility` | 382.4 | 61.2 | 261.8 |
| duckdb | `analyzer:core:2.0.0:compatibility` | 414.2 | 65.3 | 293.6 |
| mysql | `analyzer:26.7` | 178.7 | 49.0 | 29.1 |
| mysql | `analyzer:8.4` | 177.5 | 48.7 | 27.9 |
| mysql | `analyzer:9.7` | 178.6 | 48.9 | 29.0 |
| mysql | `analyzer:core:26.7` | 178.7 | 49.0 | 29.1 |
| mysql | `analyzer:core:8.4` | 177.5 | 48.7 | 27.9 |
| mysql | `analyzer:core:9.7` | 178.6 | 48.9 | 29.0 |
| postgres | `analyzer:14` | 295.7 | 72.0 | 51.2 |
| postgres | `analyzer:15` | 295.7 | 72.1 | 51.2 |
| postgres | `analyzer:16` | 296.2 | 72.2 | 51.8 |
| postgres | `analyzer:17` | 297.2 | 72.4 | 52.7 |
| postgres | `analyzer:18` | 297.7 | 72.4 | 53.2 |
| postgres | `analyzer:19` | 298.5 | 72.6 | 54.0 |
| postgres | `analyzer:core:14` | 295.7 | 72.0 | 51.2 |
| postgres | `analyzer:core:15` | 295.7 | 72.1 | 51.2 |
| postgres | `analyzer:core:16` | 296.2 | 72.2 | 51.8 |
| postgres | `analyzer:core:17` | 297.2 | 72.4 | 52.7 |
| postgres | `analyzer:core:18` | 297.7 | 72.4 | 53.2 |
| postgres | `analyzer:core:19` | 298.5 | 72.6 | 54.0 |
| sqlite | `analyzer:core` | 161.4 | 42.5 | 10.2 |
| sqlserver | `analyzer:core` | 126.2 | 36.3 | 3.0 |

Generated input counts uncompressed attributed input bytes, not compressed savings. Core-plus-pack samples include composition/options overhead and can exceed a direct full selected-analyzer import. Selection does not remove other exports from an installed package.

## Consumer graphs

| Grammar | Root tag minified / gzip KiB | Profile minified / gzip KiB | Frozen host minified / gzip KiB |
| --- | --- | --- | --- |
| duckdb | 17.1 / 5.4 | 64.1 / 18.1 | 149.3 / 42.9 |
| mysql | 17.1 / 5.4 | 47.3 / 13.3 | 132.4 / 38.5 |
| postgres | 17.1 / 5.4 | 43.8 / 12.2 | 129.0 / 37.4 |
| sqlite | 17.1 / 5.4 | 50.2 / 13.5 | 135.3 / 38.9 |
| sqlserver | 17.1 / 5.4 | 43.4 / 12.1 | 128.4 / 37.3 |

Root/query tags, profiles and frozen hosts retain zero global catalog inputs. Frozen hosts include contract loading and compiler helpers, so their bytes are not comparable functionality to an analyzer-only export. Ordinary tags already excluded large catalogs before this change. Runtime renderer/value plans and required codecs remain in application output. The [commerce report](./project-size.md) measures those actual used plans separately.

## Published installation payload

| Grammar | Grammar files MiB | Grammar dependency closure MiB | With compiler/contracts MiB | Grammar tarball KiB |
| --- | --- | --- | --- | --- |
| duckdb | 2.11 | 3.68 | 4.40 | 257.0 |
| mysql | 1.07 | 2.63 | 3.36 | 206.9 |
| postgres | 2.19 | 6.63 | 7.36 | 341.9 |
| sqlite | 0.76 | 2.32 | 3.05 | 142.7 |
| sqlserver | 0.95 | 2.52 | 3.24 | 196.5 |

Installation uses fresh isolated offline pnpm installs of built tarballs at the named revision. It counts published file contents once per package name/version, including declarations/maps; it excludes filesystem allocation, pnpm store, application-installed drivers and engine binaries. It is neither bundle size nor total disk usage. Full package exports remain installed even when a consumer imports one core.

## Reproduction

```sh
node planning/hybrid-analysis/measure-bundles.mjs HEAD planning/hybrid-analysis/bundle-measurements.json <same-tool-baseline.json>
node planning/hybrid-analysis/measure-installation.mjs
node planning/hybrid-analysis/render-measurements.mjs
```

Use the exact named code revision and repository-pinned dependencies; installation additionally requires its built publication artifacts. JSON retains source/tool/lockfile identities, output digests, attribution and external dependency versions. Measurements are byte evidence, not native query qualification. Architecture acceptance remains tracked in the [acceptance audit](./acceptance-audit.md).
