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

The [ordinary-table controls](../../test/helpers/postgres-table-contracts.ts) additionally create
real enum, composite, range and multirange columns beside the existing domain/array controls.
All are rejected by guarded native table admission on local PostgreSQL 18.3 and 18.6, even with
an empty compiler schema. Independent catalog reads assert actual `typtype` classes (`d`, `e`,
`c`, `r`, `m`) rather than relying on fixture names. Ordinary scalar table acquisitions still
pass, and the outer owning fixture removes the schema and types. This proves these relation
classes remain unavailable; it does not qualify custom return values, arbitrary domains,
extension representations or nondefault policy combinations. The 18.6 full native/descriptor
file passes in 90.41 seconds without changing its deadline; the complete 18.3 helper also passes.

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
The two hosted advanced-API profiles pass their native suites in [run 42624331784](https://github.com/Lojhan/typed-sql/actions/runs/42624331784), despite that aggregate's separate PostgreSQL flow timeout. Their captures identify merge producer `6b3bdcb6807be0b14660e54d89a7b9f6dd03c3d3`; each collector hash matches its Git blob. The reviewed [SQLite fingerprints](../../grammar/sqlite/qualification/native-descriptors.json) cover 3.53.4 on Node 24 and 3.54.0 on Node 26. The 3.53.4 fingerprint also exactly matches local Darwin/arm64 observations. Normal native tests now require the approved counts and fingerprint; a deliberately changed fingerprint fails. Unsupported API profiles now emit an explicit unavailable artifact after their negative native test. The gates and unavailable-profile reporting pass [main CI at `847fe773`](https://github.com/Lojhan/typed-sql/actions/runs/42628562585).

## MySQL source-driven type witnesses

The [MySQL extractor](../../scripts/vocabulary/mysql-descriptors.mjs) reads both lexical aliases
and every `type`/`cast_type` alternative from the existing hash-pinned engine grammar. Finite
keyword-only productions expand completely; recursive, optional and value-bearing productions
use bounded minimal witnesses. Numeric/string seeds represent terminal classes rather than a
maintained list of SQL type names. Missing witness derivations and excessive expansion fail.
Every root alternative must appear in the generated case accounting. This covers root alternatives
and lexical aliases, not all recursive modifier combinations or semantic argument constraints.

The [source projection](../../grammar/mysql/qualification/descriptor-types.json) retains 59
alternatives/136 constructors on 8.4.11 and 60/137 on 9.7.2. The canary has its own source pin and
shares byte-identical witness data with 9.7; it remains transport-unqualified. Two factored
inventories occupy approximately 33 KB without vendor parser actions or source bodies. Root
quality validates pins, hashes, root coverage and unique constructors offline. A fake-name
regression proves new lexical aliases become cases without editing a type-name list.

The [native collector](../../test/helpers/mysql-descriptor-inventory.ts) creates owned empty
InnoDB tables for all generated column declarations, captures independent information-schema
column dimensions and prepares each table/cast witness as output and parameter input. It then
compares guarded acquisition's wire descriptors with independent COM_STMT_PREPARE metadata.
Candidates are never executed or bound to example application values. Tables are removed before
the collector resolves. Owned table prefixes are retained in raw SQL but excluded from the
semantic fingerprint; policy, SQL mode, constructors, outcomes and field facts remain included.

Committed producer `d62171e192ffb1d4f1b9b7b9c34127dde29613b1` reproduces both local captures;
collector hashes match the exact Git blobs:

| Engine | Column / cast constructors | Native acquired | Unavailable | Declined | Acquired column native identity complete / partial | Acquired parameter native identity complete / partial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 8.4.11 | 99 / 37 | 260 | 2 | 10 | 58 / 202 | 29 / 100 |
| 9.7.2 | 100 / 37 | 262 | 2 | 10 | 58 / 204 | 29 / 101 |

Every independent preparation succeeds on these profiles. The two unavailable observations are
JSON parameters under default unknown-JSON policy, once through a table comparison and once
through CAST. The ten declines cover five CAST spellings in both modes: `NATIONAL CHAR`,
`SIGNED INT`, `SIGNED INT4`, `UNSIGNED INT`, `UNSIGNED INT4`. The engine accepts them; the
current native parser scope does not. They are recorded gaps rather than inferred engine failures.
The extra 9.7 constructor is VECTOR. Each acquired column set contains two unknown runtime facts
for JSON; acquired parameters retain unknown nullability. Character/temporal/enum/spatial/JSON
facets do not become complete merely because the wire family is known. Raw type-policy helper
observations are retained separately and are not parser/analyzer coverage percentages.

Both owners' isolated integration files pass locally on PostgreSQL 18.6 and MySQL 8.4.11 with
unchanged deadlines. MySQL native capture runs in its own fixture file, and all supported engine/
SQL-mode CI jobs upload detailed JSON. All six supported engine/mode collectors pass [main CI at `847fe773`](https://github.com/Lojhan/typed-sql/actions/runs/42628562585). Their constructor, independent schema, wire-field and outcome facts match the corresponding default-mode captures; fingerprints still bind each exact SQL mode. Default-mode facts also match local captures. The reviewed [MySQL fingerprints](../../grammar/mysql/qualification/native-descriptors.json) retain those six profiles plus explicitly unqualified canary observations. Captures identify merge producer `0141c90e1bc8e544d36f1c0e14210619a2278523`; collector hashes match Git blobs. Normal integration now checks the reviewed constructor count, qualification policy, outcomes and digest; explicit capture without `--check` does not change the approved data. Both local approved gates pass, and a deliberate changed fingerprint fails. The reviewed gate passes all supported modes in [main CI at `4f8b312c`](https://github.com/Lojhan/typed-sql/actions/runs/42633277370). Further modifier/policy controls and source-vs-semantic qualification remain pending. These are
acquisition observations rather than universal type/function semantics or workload qualification.

## SQL Server catalog-driven observations

The [SQL Server collector](../../e2e/sqlserver/descriptor-probe.mjs) discovers builtin type names,
IDs, dimensions, collation and CLR classification from `sys.types` on each of the ten declared
engine/compatibility pairs. It never filters discovery through the host's known-type list.
Bare NULL/cast and parameter probes complement empty table declarations and concrete modifier
controls. Table probes expose aliases/opaque families even when a bare CAST is invalid. New
source names receive probes automatically; unknown or malformed catalog layouts fail validation.

Independent parameter/result metadata comes from `sp_describe_undeclared_parameters` and
`dm_exec_describe_first_result_set`. Candidate text is bound as metadata-API input, never executed
or supplied sample application values. A probe without independent metadata is recorded as
not attempted by the adapter; its failure does not prove a whole family unsupported. Successful
native acquisitions must agree on shape, type IDs, dimensions, XML collection IDs and collation.
Async statement guards can still decline an ordinary-looking relation with unsupported types.

The standalone qualification step records exact build, compatibility, server settings, default
policy, installed ODBC package, runtime and both collector/helper content hashes. Field records
are factored by digest. Semantic fingerprints normalize only the owned database name and inline
field references to avoid random database names changing otherwise identical facts. Partial
runs retain their active declaration/probe and cleanup status. Unknown server diagnostics,
permissions, resource failures and transport failures fail the audit; recognized statement and
metadata-unavailability diagnostics remain distinct. The owned database is dropped before final
publication, and failed cleanup prevents success.

All ten pairs pass native capture and owned-database cleanup in [main CI at `4f8b312c`](https://github.com/Lojhan/typed-sql/actions/runs/42633277370).
The captures identify merge producer `17e85eb2e9690119453b416af46d5eca9524902c`; both collector
and discovery-helper hashes match their Git blobs. All use Node 24.22.2, Linux x64 and Microsoft
ODBC package 18.7.1.1-1. Exact builds are retained in the reviewed
[fingerprints](../../grammar/sqlserver/qualification/native-descriptors.json).

| Engine build | Compatibility targets | Catalog names | Probes per target | Acquired | Declined | Adapter unavailable | Partial | Independent unavailable / rejected |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 14.0.3560.2 | 140 | 34 | 156 | 134 | 8 | 6 | 2 | 6 / 0 |
| 15.0.4500.2 | 140, 150 | 34 | 156 | 134 | 8 | 6 | 2 | 6 / 0 |
| 16.0.4305.5 | 140, 150, 160 | 34 | 156 | 134 | 8 | 6 | 2 | 6 / 0 |
| 17.0.5035.5 | 140, 150, 160, 170 | 36 | 162 | 137 | 8 | 6 | 2 | 7 / 2 |

Counts include aliases and multiple witnesses per name; they are not type-family coverage
percentages. Independent unavailable/rejected witnesses are not attempted through the adapter.
All 34 older-engine column declarations succeed. On 17, 35 of 36 declarations succeed; bare
`vector` is rejected with native diagnostic 2715 and both bare CAST witnesses are rejected.
This does not establish availability of concrete vector dimensions.

Bare `geography`, `geometry`, `hierarchyid` and `sysname` casts are declined by the adapter's
select scope. Their table queries remain guarded-statement unavailable, except geography/geometry
parameter comparisons whose independent metadata is already unavailable. Table comparisons for
`image`, `ntext`, `text` and `xml` also lack independent metadata; 17 adds `json` to that set.
Both `sql_variant` parameter witnesses remain partial. None of these outcomes becomes an
optimistic contract or a universal family verdict.

Acquired outputs retain 134 complete native identities on 14–16 and 137 on 17, including two
unknown runtime representations per target. Acquired input fields retain 52 complete identities
and 12 partial on 14–16, versus 52 complete and 13 partial on 17. Nullability remains a nullable
upper bound; complete native identity does not prove refined nullability or JSON shape.

Normal hosted qualification now runs `node descriptor-probe.mjs --check` and requires every
compatibility target, successful cleanup, exact counts and its reviewed semantic fingerprint.
Capture mode omits `--check`, retains full observations and never changes approved data.
Replay of all four actual hosted reports passes the gate; deliberately altered fingerprints fail
on every engine. Unit regressions reject missing/duplicated targets, incomplete runs, cleanup
failures and inconsistent accounting, and prove that a partial-to-acquired change requires review.
The gate passes all ten fresh hosted captures in [run 42637006229](https://github.com/Lojhan/typed-sql/actions/runs/42637006229), with successful case and database-cleanup status. That aggregate separately fails PostgreSQL watch regeneration and SQL Server 17's later packed editor check; these descriptor results do not make the aggregate green.

The native statement probe additionally creates a typed XML collection/table and a builtin CLR
`hierarchyid` table beside its existing alias/computed/RLS controls. Both must be rejected by
relation admission on every declared compatibility pair. Local syntax and descriptor/native
unit suites pass; actual hosted execution of these new class controls is pending. This tests
unavailability at the relation boundary and does not promote typed XML or CLR runtime codecs.

## Capability boundaries used for acceptance

The common evidence format has three independently qualified facets: native identity (including
its completeness flag), runtime representation and nullability (exact or upper bound). Raw
descriptor fields do not add a fourth route to optimistic typing. These claims apply only after
the owner's statement/context admission succeeds. An acquired statement can still fail the
project's required-facet policy.

| Owner and exact native observations | Native identity and modifiers | Runtime representation | Nullability and other semantic limits |
| --- | --- | --- | --- |
| PostgreSQL 18.3 / 18.6 | Parse/Describe OIDs and output typmods are compared with independent protocol results. Parameter typmods are unavailable; modifier-bearing inputs remain incomplete. Other hosted majors have protocol observations but no qualified native adapter. | Selected builtin scalar mappings use the selected codec policy. JSON parameters remain unavailable under the default policy. Array/custom/domain identities never imply a qualified representation. | Protocol descriptions provide no expression nullability. JSON shape, cardinality and dependent function behavior are unavailable from this mechanism. |
| MySQL 8.4.11 / 9.7.2, six supported modes | Wire type/flags and independent column facts are captured. Character, temporal, enum, spatial and JSON identity can remain partial. Raw width/charset/decimals are retained without upgrading binding identity. | Default-policy JSON input representation is unavailable. Known wire families use the same runtime policy; output facts may remain unknown. Canary transport is unqualified. | Parameters have no nullability claim. Output NOT_NULL evidence can be exact; nullable output evidence is an upper bound. JSON structure and all recursive modifier combinations remain unqualified. |
| SQLite 3.53.4 / 3.54.0 advanced-API profiles | Every acquired identity is an incomplete storage-domain identity, including STRICT and NOT NULL columns. Origin declarations are retained but do not establish arbitrary expression types. Missing authorizer/column APIs make native acquisition unavailable. | Four audited policies retain broad storage domains; unknown-flexible parameters are unavailable. Separate runtime tests exercise integer and binding policy. | Nullable upper bounds are retained even for declared NOT NULL sources. Declared widths, decimal precision, JSON shape and arbitrary expression nullability are unavailable. |
| DuckDB 1.5.6 / 2.0.0 | SDK logical trees cover all modeled kinds with concrete controls; output/input descriptors retain nested dimensions and labels. ANY/INVALID and unmodeled kinds remain unknown. Bare parametric names can be declined. | Known logical trees use the owner codec policy; unresolved parameter representation prevents acquisition. NULL-typed input remains unavailable. | Prepare does not establish nullability. Nested element nullability stays conservative. All possible nested/custom/extension/policy combinations are not certified by these controls. |
| SQL Server exact builds and all ten pairs listed above | Independent metadata retains system/user IDs, dimensions, collation and XML facets. Missing input collation, aliases and XML collections can leave identity incomplete. | Opaque CLR and sql_variant descriptors do not establish a runtime representation. Unavailable independent metadata is not attempted through the adapter. | Native NOT NULL output can be exact; nullable outputs and inputs retain upper bounds. CLR/custom/XML/JSON/vector semantics and arbitrary batches are not inferred from acquired metadata. |

The negative and policy boundaries are asserted in the grammar-owned suites:
[PostgreSQL](../../packages/postgres/test/native-contracts.test.ts),
[MySQL](../../packages/mysql/test/native-contracts.test.ts),
[SQLite](../../packages/sqlite/test/native-contracts.test.ts),
[DuckDB](../../packages/duckdb/test/native-contracts.test.ts) and
[SQL Server descriptor controls](../../packages/sqlserver/test/contract-descriptors.test.ts).
Those unit controls establish interpretation/fail-closed behavior, while the independently
captured exact-engine inventories above establish the specified native observations. Unit
fixtures do not certify an unobserved engine or policy combination.

Reusable routine metadata is narrower still: PostgreSQL's selected fixed-scalar project
catalog rules are qualified separately. The other owners supply exact-query evidence rather
than universal reusable routine declarations. Named/default/polymorphic/table-output calls
and argument-dependent rules do not inherit permission from a successful simple invocation.
No owner derives JSON object shape, cardinality, execution effects or universal overload rules
from a type-name inventory. Missing evidence remains unavailable or partial in the durable
contract and is checked again against the project's required-facet policy.

## Remaining owners

SQL Server now has reviewed observations and passing fresh drift gates for all ten pairs; additional concrete/custom-family controls remain open. PostgreSQL still requires additional class/policy controls. SQLite's reviewed gate passes the latest full aggregate. MySQL's hosted mode observations and reviewed drift gate pass required CI. Existing real/native unit and packed tests remain evidence for their declared invocations. They do not substitute for independent inventory-driven family accounting. In particular, SQLite storage domains are not arbitrary-expression result types, MySQL modifiers/parameter authority can be partial, PostgreSQL custom/domain/polymorphic bindings need separate rules, and SQL Server opaque/custom/XML/collation facets can be unavailable. Acceptance scenario 17 remains open.
