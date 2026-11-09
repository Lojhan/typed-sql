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

## PostgreSQL catalog-driven observations

The [PostgreSQL collector](../../test/helpers/postgres-descriptor-inventory.ts) discovers defined
bootstrap `pg_catalog` types below the normal-object OID boundary, excluding relation row types.
Each name receives independent protocol Parse/Describe output and parameter probes in a read-only
transaction. Candidate statements are never bound or executed. Array, pseudo, range and multirange
names remain in the inventory even when the qualified native adapter declines them. Pseudo-type
resolution is retained as observed; a polymorphic spelling is not assumed to retain its input OID.

At committed producer `745a48a0c13ad214ff96907436f70aa491c28ec6`, PostgreSQL 18.3 discovers 329
types: 291 base types (including arrays), 26 pseudo types, six ranges and six multiranges.
There are 658 catalog probes and 12 concrete modifier probes:

| Independent protocol outcome | Native adapter outcome | Probes |
| --- | --- | ---: |
| Described | Acquired | 46 |
| Described | Declined by statement scope | 612 |
| Rejected by engine | Declined by statement scope | 10 |
| Described | Parameter runtime evidence unavailable | 2 |

The two unavailable cases are JSON/JSONB parameters. Their protocol OIDs are present; this does
not imply a qualified runtime representation. Engine rejections include `anyenum` casts and
handler/trigger/internal pseudo types. A declined array or range probe records an adapter
restriction, not missing engine support. Counts include internal names and do not measure
application popularity or universal family coverage.

Numeric precision/scale, character length and timestamp precision controls compare acquired
OID/modifier facts with independent protocol descriptions. Positive controls require acquisition,
known runtime representations and complete column identity. Parameter identity must remain
incomplete for modifier-bearing types; PostgreSQL's parameter descriptions provide no typmod.
Unknown nullability remains unknown. The interval-field control is described by the engine but
declined by the current statement scope.

The capture records exact server/client/runtime identities and collector content hash. Its local
semantic fingerprint is `894ece5afb201c2e76aa829c3b949d2e1fc7ce46cc6f6cfffc96045c551fc97a`;
the collector hash matches its committed Git blob. Typechecking and root quality pass. Every
PostgreSQL CI profile now captures the inventory before adapter qualification; unsupported
transport versions retain protocol facts with explicit adapter unavailability. Always-uploaded
artifacts retain full fields factored by digest. All six hosted collectors pass [run 42622087624](https://github.com/Lojhan/typed-sql/actions/runs/42622087624). The reviewed fingerprints below now retain their exact observed boundaries; the new gate still requires its own hosted aggregate.

```sh
TYPED_SQL_POSTGRES_URL=postgres://localhost/owned_audit_database \
TYPED_SQL_NATIVE_DESCRIPTOR_DIRECTORY=/tmp/typed-sql-native-descriptors \
pnpm exec tsx test/helpers/postgres-descriptor-inventory.ts
```

User/extension types, relation row types, nondefault policies and additional modifier/composition
boundaries still need separate evidence. This stage neither widens adapter admission nor ships
catalog captures in package bundles.

## PostgreSQL reviewed engine boundaries

The [reviewed fingerprints](../../grammar/postgres/qualification/native-descriptors.json) retain
local 18.3 and all six hosted profiles independently. Hosted captures identify merge producer
`bee9cb22caeff0b2de9570bd50f92fd420477b78`; each collector content hash matches its Git blob.
Normal native integration requires the exact reviewed engine key, complete probe counts and
semantic fingerprint. Explicit capture without `--check` never changes the approved file;
`--check` qualifies it. A deliberate fingerprint change fails against actual local 18.3, and
exact restoration passes.

| Engine | Catalog names | Protocol described / rejected | Adapter acquired / unavailable / declined |
| --- | ---: | ---: | ---: |
| 14.24 | 319 | 639 / 11 | 0 / 650 / 0 |
| 15.19 | 324 | 649 / 11 | 0 / 660 / 0 |
| 16.15 | 325 | 651 / 11 | 0 / 662 / 0 |
| 17.11 | 327 | 655 / 11 | 0 / 666 / 0 |
| 18.3 local | 329 | 660 / 10 | 46 / 2 / 622 |
| 18.6 hosted | 329 | 659 / 11 | 46 / 2 / 622 |
| 19beta3 | 345 | 691 / 11 | 0 / 702 / 0 |

Counts include twelve modifier probes per engine. Outside major 18, adapter unavailability is
its explicit qualification policy, independently asserted by the existing real context test;
protocol descriptions do not widen that policy. The 18.3/18.6 inventories and acquired field
facts agree, but `internal` pseudo-type casts differ: the output rejection changes SQLSTATE,
and the parameter changes from described to rejected. The adapter declines both invocations
on both versions. This difference is retained instead of merging fingerprints by major or
silently treating every patch as identical.

## SQLite standard names and storage-domain boundaries

The [source collector](../../scripts/generate-sqlite-descriptor-types.mjs) extracts standard
names, affinities and byte lengths from three matching `sqlite3StdType*` tables in pinned
`src/global.c`. It follows the existing nineteen vocabulary source revisions without adding
runtime vocabulary dependencies. All profiles currently share six names; source facts are
factored once and each profile retains its own pin digest. No vendor source bodies are committed.
The root quality check validates pins/facts offline; explicit `--refresh` downloads only the
validated vendor path and verifies length/content hashes. Parser controls reject missing,
duplicate, inconsistent and nonliteral declarations; fake names prove extraction is not a
maintained copy of the six-name list.

The [native collector](../../packages/sqlite/test/helpers/descriptor-inventory.ts) chooses an
exact engine source profile and checks every discovered name against offline STRICT recognition,
actual STRICT/non-STRICT table metadata and cast-parameter preparation. It adds NOT NULL,
open declaration, missing declaration, CASE, NULL and JSON-expression controls. Owned tables
are empty; candidates are never stepped or bound to sample values. Independent driver column
metadata is compared with acquired origin evidence. Standard names are a finite source set;
ordinary declared type names are open and do not admit an exhaustive alias list.

At committed producer `f6a5fb0745d3dc0ab953012da40ee4fa7b457d3b`, SQLite 3.53.4 on Node 24.22.2
passes 28 probes across default, number-integer, unknown-flexible and parsed-JSON policies:
**103 acquired and nine explicitly unavailable** observations. The unavailable observations
are parameterized queries under unknown-flexible policy. No concrete parameter runtime domain
is invented. Acquired native identities remain incomplete storage-domain identities, including
STRICT and NOT NULL table controls. Nullability remains a nullable upper bound. Cast/CASE/JSON
expressions supply no declared type and gain no JSON shape or precision from these descriptions.
These controls complement the existing real runtime tests for storage values and integer/binding
policy; they do not establish every possible custom declaration or policy combination.

The collector hash matches its committed Git blob. Its semantic fingerprint is
`b161d5ad48d2cce47419bad71b5b204d8fe42614f564fe7bfbae87b1bbb533a9`.
The full SQLite suite passes nineteen files with its existing coverage thresholds, root types,
all 53 repository contract files and quality pass. Source-quality and Node-matrix jobs upload
detailed captures. Runtimes without authorizer/column APIs retain their existing explicit
unavailable-profile test; no descriptor capability is inferred from a skipped native suite.
Hosted capture review and approved per-profile drift fingerprints remain pending.

## Remaining owners

MySQL and SQL Server still need a reconciled descriptor-family availability review beyond the representative [16-profile facet report](./native-costs.md). PostgreSQL still requires additional class/policy controls; SQLite's initial source/native review still requires hosted observations and a reviewed drift gate. Existing real/native unit and packed tests remain evidence for their declared invocations. They do not substitute for independent inventory-driven family accounting. In particular, SQLite storage domains are not arbitrary-expression result types, MySQL modifiers/parameter authority can be partial, PostgreSQL custom/domain/polymorphic bindings need separate rules, and SQL Server opaque/custom/XML/collation facets can be unavailable. Acceptance scenario 17 remains open.
