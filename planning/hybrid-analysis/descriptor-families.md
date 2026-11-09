# Native descriptor-family review

This review separates native descriptor observations from reusable function semantics, query qualification and runtime value tests. A known return type on one prepared statement does not establish every invocation, modifier, nullability refinement or JSON shape. The full five-grammar review remains incomplete.

## DuckDB live inventory

The collector discovers internal type names from `duckdb_types()` rather than a copied name list. Repeated names across namespaces are retained with their locations and grouped only after logical-type/category agreement. Every discovered spelling receives a guarded output probe and a typed-parameter probe. The constructor controls cover every modeled type kind through a TypeScript-exhaustive record and verify native logical trees, precision/scale, labels/dimensions, runtime representations and unknown nullability. No candidate is executed, bound to values or supplied sample application arguments.

The six scalar alias gaps exposed by the first run are fixed from independently matching native facts on both engines: `DEC → DECIMAL`, `GUID → UUID`, `INTEGRAL → INTEGER`, `NVARCHAR → VARCHAR`, `OID → BIGINT`, `TIMESTAMP_US → TIMESTAMP`. Contract/reconciliation compatibility identities advance; old DuckDB contracts require regeneration. The offline reference change is reviewed separately: exactly those six type observations improve on each engine, with no other reference fields changed. Recognition remains labelled semantics-unverified.

| Engine | SDK | Catalog spellings | Namespace rows | Bare output acquired | Bare parameter acquired | Constructed output / parameter acquired | Declined probes | Unavailable probes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| v1.5.6 | 1.5.6-r.2 | 83 | 244 | 73 | 72 | 10 / 10 | 20 | 1 |
| v2.0.0 | 2.0.0-r.1 | 84 | 316 | 73 | 72 | 10 / 10 | 22 | 1 |

Acquired means native descriptors were obtained, not that an independent static/native qualification succeeded. Counts include aliases and are not type-family coverage percentages. The `NULL`-typed parameter remains `parameter-metadata-unavailable`; it is never replaced with a sample value. Bare parametric spellings can be declined even when concrete members of their family are supported.

- v1.5.6 declined bare spellings: `array`, `enum`, `geometry`, `list`, `map`, `row`, `struct`, `type`, `union`, `variant`.
- v2.0.0 declined bare spellings: `array`, `enum`, `geometry`, `list`, `map`, `row`, `struct`, `tuple`, `type`, `union`, `variant`.

Concrete controls independently exercise decimal bounds, enum labels, lists, fixed arrays, named/nested structs, maps, tagged unions and unnamed tuples. They do not infer support for every possible nested composition or arbitrary future logical types. User-defined types, extensions, nondefault policies and query-context-dependent parameter inference require their own evidence; they are not covered by this inventory claim.

## Provenance and automatic checking

The approved observation fingerprints are in [native-descriptors.json](../../grammar/duckdb/qualification/native-descriptors.json). Both captures identify committed producer `f44f49ad1c5d2c9d361e1b8d24dc396044e0fe18`, exact SDK versions, client platform/runtime and the collector content hash. Every recorded collector hash matches its Git blob at that revision. Host/namespace duplication and capture provenance are excluded from the semantic fingerprint so the same exact-engine descriptor behavior can be checked across hosts; names, categories, SQL, outcomes, native trees and modifier facts remain included.

Normal native suites compare fresh observations against those reviewed fingerprints. New names, changed outcomes or altered metadata require review. A newly modeled kind also makes the constructor record incomplete at compile time until a matching concrete control is added. CI uploads detailed JSON under `typed-sql-native-descriptors-*`, including full parameter/output facts with repeated field records factored by digest. Source-quality failure does not suppress artifact upload.

Reproduce captures explicitly; capture mode never updates the reviewed baseline:

```sh
pnpm --filter @typed-sql/duckdb test:native --capture-descriptors /tmp/typed-sql-native-descriptors
```

## Remaining owners

PostgreSQL, MySQL, SQLite and SQL Server still need a reconciled descriptor-family availability review beyond the representative [16-profile facet report](./native-costs.md). Existing real/native unit and packed tests remain evidence for their declared invocations. They do not substitute for independent inventory-driven family accounting. In particular, SQLite storage domains are not arbitrary-expression result types, MySQL modifiers/parameter authority can be partial, PostgreSQL custom/domain/polymorphic bindings need separate rules, and SQL Server opaque/custom/XML/collation facets can be unavailable. Acceptance scenario 17 remains open.
