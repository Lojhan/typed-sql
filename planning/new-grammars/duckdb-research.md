# DuckDB integration research

Internal engineering evidence and design, researched 2026-11-05 for issue #254.
This document is a proposal, not a claim that an unpublished grammar is supported.
The implementation must satisfy the acceptance matrix below before public compatibility claims.

## Evidence and decisions

- Current DuckDB is **2.0.0 LTS**, released 2026-10-21; 2.0.1 is scheduled for 2026-11-18 and must not be treated as released. Official 1.5.6 was released 2026-09-28; 1.4.5 remains the latest patch of the older LTS. Official support ends 2027-10-22 for 2.0, 2027-03-01 for 1.5, and 2026-11-17 for 1.4. See [release calendar](https://duckdb.org/release_calendar).
- npm inspection returned `@duckdb/node-api` latest **2.0.0-r.1** and `lts-v1.4` **1.4.5-r.1**. The package version has an SDK revision suffix; it is distinct from engine `version()` (`v2.0.0`). Neo [official releases](https://github.com/duckdb/duckdb-node-neo/releases) also list 1.5.6-r.2. Do not infer support from stale preview docs which still call 1.4.5 latest.
- Use **`@duckdb/node-api` (Neo)** as the first application-owned Node adapter. The old `duckdb` Node client is deprecated and should not become our default dependency. Wasm is a separate driver/transport qualification, not a second grammar. Neither Wasm nor Quack/MotherDuck remote execution is silently covered by Node embedded tests.
- Recommended initial full-integration policy: **qualified engines 1.5.6 and 2.0.0**, explicitly disjoint version windows, backed by **Neo 1.5.6-r.2 and 2.0.0-r.1**. Both SDK/engine pairs were actually probed. The floor is1.5.6;1.5.0–1.5.5 are not silently promised by saying “1.5.x.” Older1.4.5 is an explicit unsupported negative target: upstream support ends in12days and its SDK lacks the deterministic lifecycle needed for equal adapter maturity. There are no existing typed-sql DuckDB users to strand. Any future widening/lowering requires a successful full matrix. Future patches/minors/majors and prereleases are conservative until qualified; unknown1.6–1.9 are never implied supported by a continuous range.
- Neo 2.0 has breaking behavior and an upstream VARIANT logical-type construction issue. Reading `SELECT 1::VARIANT` works in the observed SDK, but constructing/binding every VARIANT case is not proven. Reject a claimed concrete VARIANT runtime policy until recursive type/value fidelity is demonstrated; represent unresolved/dynamic values as `unknown` or a diagnostic. This is an explicit capability boundary, not grounds to ignore 2.0 entirely.

## Real engine observations, not only documentation

A read-only research checkout of `duckdb/duckdb-node-neo` tag `v2.0.0-r.1` is in ignored `artifacts/research/duckdb-node-neo`. An isolated npm installation and executed probes are in ignored `artifacts/research/duckdb-probe`; `probe.cjs`, `results.json`, `probe-edges.cjs`, and `edge-results.json` preserve the observations. These are research artifacts, not committed product tests; turn them into deterministic package/E2E fixtures during implementation.

Observed on actual engine v2.0.0:

1. LIST and fixed ARRAY return wrappers with `items`; STRUCT has `entries`; unnamed STRUCT/TUPLE has positional `items` preserving every field, including a NULL third field.
2. MAP returns ordered `entries: [{key,value}]`, with numeric keys and NULL values preserved. UNION returns `{tag,value}`. `union_value(x := NULL)` is `{tag:'x',value:null}`, while outer SQL NULL is JavaScript `null`.
3. Signed HUGEINT max, unsigned UHUGEINT max, and a larger BIGNUM return exact `bigint`. DECIMAL(38,4) returns width, scale and exact bigint coefficient.
4. TIMESTAMP_NS and new TIMESTAMPTZ_NS return exact nanosecond ticks; INTERVAL has months/days/micros.
5. `extractStatements('SELECT 1; SELECT 2').count` is 2. Preparing named `$name` twice returns one native parameter with a name and INTEGER type. Typed MAP/UNION parameters expose nested native metadata. Unconstrained `SELECT $1` has unavailable logical parameter type; report that evidence as unavailable rather than inventing one.
6. Duplicate output aliases are preserved at a top-level SELECT, but a derived table deduplicates them (`same`, `same_1`). Runtime object decoding must reject top-level duplicates unless a public positional-result contract is introduced. Static derived-table expansion must follow native deduplication; do not globally rename all duplicates.
7. Backtick quoting works in 2.0. Quoted references still resolve ASCII-case-insensitively, including backtick-quoted names. A session variable named `id` did not cause prepared `$id` to disappear as a parameter; do not invent a variable/placeholder collision rule without an engine probe.
8. `duckdb_columns()` in 2.0 contains `is_generated` and `generation_expression` which are absent on older versions. `duckdb_functions()` includes parameter names/types, varargs, return type, macro definition, side effects, extension and stability metadata. Provider queries must gate columns by actual version or introspected shape. The1.5.6-r.2 probe also passed nested/decimal/wideint/parameter metadata cases and rejected2.0-only temporal syntax as expected; its prepared column metadata and result close methods are present.

Packed SDK inspection also confirms:

- **1.4.0-r.2** already has `bindMap`, `bindUnion`, BIGNUM support and parameter metadata. Its prepared statement does **not** have result-column metadata methods, and its result lacks `closeSync()`.
- **1.4.5-r.1** also lacks result `closeSync()` in its published declarations; it is a negative unsupported runtime target, not our default adapter baseline.
- **1.5.6-r.2** explicitly adds streaming/pending result release; **2.0.0-r.1** carries the prepared-result statement-type workaround.
- Therefore grammar support, adapter support, live-verifier metadata availability, and streaming support require separate matrices. No fallback may execute a query merely to discover its result metadata.

## Required public package shape and ownership

`packages/duckdb` should match the existing mature grammar package architecture:

- Root: `duckdb()`, `sql`, `typePolicy`, public snapshot types/validation, `DuckDBSchemaProvider`, grammar capability/support helpers, and neutral policy/codec contracts.
- `/query`: lightweight sql tag + `$1` renderer and `"identifier"` quoting. No native addons, fs, compiler, config, preview TS, or grammar parser in a browser runtime import graph.
- `/runtime`: driver-neutral runtime over explicit structural connection/statement/result contracts; codecs owned by DuckDB semantics, and capability tokens for proven services.
- `/node-api`: explicit SDK adapter/importer/opening helper. The application installs and owns Neo and its database instance/connection. Optional SDK loading must never occur through the grammar root or query entrypoint. SDK type imports, if exposed, remain on this explicit subpath and must survive packed consumers without an accidental required driver root dependency.
- Optional future `/wasm` is a separate qualification. Do not add it as an untested alias of Node.

Provide examples, CLI init/introspection/config validation, SQL asset factories, inline build transforms, language-server completion/hover/diagnostic parity, playground fixtures, schema drift/diff, package/release manifests and documentation navigation. A parser-only npm package is not the requested final product.

## Logical JavaScript policy and codecs

All choices below must appear in a grammar-owned type policy, canonical policy hash and the same runtime decoder/encoder. Avoid using Neo's `getRowsJS()` as the default: its standard converter turns DECIMAL into double and timestamps into Date, which loses information. Consume native wrappers with native logical-type evidence, recursively normalize, then run the core compiled-plan validation.

| SQL family | Proposed default logical value | Requirements |
|---|---|---|
| BOOLEAN | boolean | No integer surrogate accepted implicitly |
| TINYINT/SMALLINT/INTEGER and UTINYINT/USMALLINT/UINTEGER | number | Integral bounds validated on bind; unsigned 32-bit still safe |
| BIGINT/UBIGINT/HUGEINT/UHUGEINT/BIGNUM | bigint | Preserve signedness/width in physical target; reject out-of-range fixed-width inputs before execution |
| DECIMAL(p,s) | exact canonical string retaining scale | Parse/format bigint coefficient; no Number intermediate; reject unrepresentable values rather than unrequested rounding |
| FLOAT/DOUBLE | finite number | Core currently rejects NaN/infinity and unsafe integral numbers; explicitly document/reject those values. A richer policy is separate reviewed work, never a hidden relaxation of core |
| VARCHAR/ENUM/UUID | string; enum literal union when configured | Enum dictionary and UUID validation; never misidentify JSON alias as VARCHAR |
| BLOB | copied Uint8Array | Detach from native chunks before release/reuse |
| BIT | canonical binary string | Preserve bit length and padding; byte-only conversion loses leading/padding information |
| DATE/TIME/TIME_NS/TIMESTAMP variants | lossless canonical string policy | Cover BC/range/infinity and micro/nanosecond precision; timezone-aware formatting must be deterministic, not host timezone or mutable SDK static offset |
| INTERVAL | readonly `{months:number,days:number,micros:bigint}` | Do not normalize months into fixed milliseconds |
| JSON | text by default; parsed/structural policy explicit | Distinguish SQL NULL from JSON null; preserve exact raw JSON text by default; reuse existing JSON shape contracts and validation |
| LIST | readonly `(T|null)[]` | Outer container NULL separate from element NULL; narrow only when expression evidence proves non-null elements |
| ARRAY(T,N) | readonly exact-length sequence | Runtime validates N; emit bounded TS tuple where reasonable, otherwise a documented bounded representation; never silently discard length |
| STRUCT | readonly object with required keys | Per-field descriptor/nullability; conservative nested NULL unless construction proves otherwise |
| unnamed STRUCT/TUPLE | readonly positional tuple | Preserve field order and repeated/unnamed entries; never object-flatten |
| MAP(K,V) | ordered readonly key/value pairs | K is typed, non-null; V may be NULL; support non-string and composite keys. Do not stringify keys or assume JS Map reference-equality implements DuckDB key equality |
| UNION | discriminated `{tag:'member';value:T|null}` alternatives | Outer NULL remains separate; preserve active NULL tag; validate membership and bounds recursively |
| GEOMETRY/VARIANT/extension types | diagnostic/unknown until exact codec qualified | Explicit extension manifest or proven built-in codec; no optimistic any or lossy object conversion |

`NUMERIC` is DECIMAL, not PostgreSQL arbitrary-precision numeric: omitted modifiers mean (18,3), one width argument means scale0, width is1–38 and scale0–width. Implement DuckDB's exact arithmetic promotion and division behavior instead of copying PostgreSQL or JS arithmetic. Combination casting for constructors/set operations is different from ordinary implicit function casts. E.g. signed64+unsigned64 can promote to signed128; BOOL participates differently in combination casting. Record these as versioned grammar tables with differential tests.

Useful primary sources: [numeric types](https://duckdb.org/docs/2.0/sql/data_types/numeric), [timestamp types](https://duckdb.org/docs/2.0/sql/data_types/timestamp), [nested type overview](https://duckdb.org/docs/2.0/sql/data_types/overview), [UNION](https://duckdb.org/docs/2.0/sql/data_types/union), [MAP](https://duckdb.org/docs/2.0/sql/data_types/map), [casting](https://duckdb.org/docs/2.0/sql/data_types/typecasting).

## Neutral core/AST changes justified by these requirements

Current `packages/core/src/query-value-plan.ts` supports primitives, JSON, literal, array and union. It cannot validate native STRUCT fields or heterogeneous tuples. The minimal shared extension is generic JavaScript **plain object properties**, **tuples**, and optional **array length**, with per-child descriptors/nullability. Existing union-of-object descriptors can express discriminated UNION; core need not know the SQL word UNION. MAP can be represented as array-of-key/value tuples, avoiding a dialect-specific core MAP node.

Every recursive place must be extended together: normalization/copy, depth/node budgets, immutable ownership, transport bigint traversal, JSON-null ambiguity, scalar encode/decode, nested JSON input detection, TS parameter rendering, result-validation/stream wrappers, query plan selector equality, and artifact format/compatibility validation. Include hostile/cyclic/prototype-property fixtures and avoid optimistic coercions. `normalizeValue` is currently a top-level decoder callback; recursively unwrap SDK values in the adapter rather than silently changing that callback's semantics for all existing drivers.

The compiler currently discards `ResolvedParameter.databaseType` while building query value plans. DuckDB nulls, empty collections and DECIMAL values need an exact native target. Add a bounded opaque physical target field carried through plans, understood only by the grammar/runtime adapter; core must not parse a DuckDB DECIMAL or install a target dialect enum. Decide between additive `databaseType?:string` and a versioned opaque transport descriptor with the SQL Server/shared review. Do not use arbitrary native SQL snippets as executable casts without type-parser validation.

Observed2.0 MAP probes accepted LIST keys with NULL elements, STRUCT keys with NULL fields, UNION keys and MAP-as-key; outer NULL keys failed, and duplicate LIST keys containing NULL failed structural uniqueness checks. Do not implement that equality with JavaScript object identity. Fixed ARRAY rejected0 and negative dimensions; the engine maximum is100,000 per dimension in the observed2.0 binary. Multiple dimensions preserve suffix ordering. The same probe was executed on1.5.6 and confirmed the accepted MAP families, structural duplicate/NULL rejection, ARRAY1..100,000 bound and multidimensional suffix behavior; error wording differs for negative dimensions.

The generic AST toolkit parameter profile only has question, numbered-question and numbered-dollar. DuckDB requires a grammar profile for `$name` and named arguments `:=`, lambdas, list/struct/map literals, indexing/slicing and versioned quote modes. Add neutral lexical primitives only where useful to multiple grammars; DuckDB AST nodes and semantics stay in its package. Never import PostgreSQL's parser with a syntax mode and call it DuckDB.

No core SQL operation enum change is required: analytical SELECT is read, CTAS/COPY/DDL uses existing operation/effect facts, unsupported/dynamic effects are conservative. Transaction routing, connection affinity and volatility already have neutral contracts.

## Parser/resolver completion scope

Full mature baseline before claiming parity:

- Identifiers: ASCII case-insensitive resolution, preserved output spelling, double quotes, backticks gated to2.0, three-part catalog/schema/relation names and four-part column names, search path, duplicate names/derived deduplication. Avoid Unicode lowercasing which incorrectly equates non-ASCII identifiers.
- Expressions: literals including numeric underscores, casts/TRY_CAST and `::`, comparisons/3VL, boolean ops, CASE/COALESCE/IFNULL, arithmetic promotions, function overloads, named arguments, list/array/struct/tuple/map constructors, field/index access, slicing and bounds/nullability.
- SELECT/FROM-first and projection expansion; aliases and lateral aliases, `* EXCLUDE/REPLACE`, statically resolved COLUMNS expansion; WHERE/HAVING/GROUP/ORDER aliases where legal.
- Joins: inner/outer/cross/lateral/semi/anti, ASOF and positional when proved, USING/NATURAL output shape and outer nullability. Unknown table functions do not produce invented columns.
- CTEs, nested CTEs, bounded recursive inference, USING KEY if included and version-proven, scalar/subquery/EXISTS/IN, UNION/INTERSECT/EXCEPT and BY NAME with correct missing-column NULLs.
- Aggregates and windows, FILTER/order-sensitive aggregates, GROUP BY ALL/ROLLUP/CUBE/GROUPING SETS, WINDOW frames and QUALIFY. `list`, `first`, `last` retain input NULLs; list on an empty group is SQL NULL, not an empty list. COUNT alone is non-null; aggregate promotion is DuckDB-owned.
- UNNEST in SELECT and FROM, recursive and max_depth only for supported form; multiple SELECT-list UNNEST pads shorter lists with NULL, so output element nullability widens. STRUCT UNNEST expands columns using static fields; dynamic recursion/depth cannot promise a fixed schema.
- LIMIT/OFFSET/FETCH with integer parameter validation; LIMIT percentages and sampling have explicit semantics/version support or diagnose.
- INSERT VALUES/SELECT, BY NAME, OR IGNORE/REPLACE and ON CONFLICT; UPDATE/FROM, DELETE/USING, RETURNING; MERGE INTO with per-action result schema and merge_action. CTAS and fixed-shape analytical commands such as DESCRIBE/SUMMARIZE require their own result descriptors.
- Fixed-domain PIVOT/UNPIVOT can be statically typed only with known IN values and known expressions. Data-driven pivot output is diagnostic/unknown, never typed from a sample file or current rows.
- DDL, SET/USE/ATTACH, transactions, COPY/import/export and side-effecting functions cannot be classified as safe reads merely because a wrapper contains SELECT. External file/network/schema discovery is dynamic unless an explicit immutable schema declaration exists. No build-time query evaluation to infer data-derived output.

The [friendly SQL inventory](https://duckdb.org/docs/2.0/sql/dialect/friendly_sql), [UNNEST](https://duckdb.org/docs/2.0/sql/query_syntax/unnest), [QUALIFY](https://duckdb.org/docs/2.0/sql/query_syntax/qualify), [PIVOT](https://duckdb.org/docs/2.0/sql/statements/pivot), [WITH](https://duckdb.org/docs/2.0/sql/query_syntax/with), [MERGE](https://duckdb.org/docs/2.0/sql/statements/merge_into), and [identifier rules](https://duckdb.org/docs/2.0/sql/dialect/keywords_and_identifiers) are the upstream scope references. Specific2.0 additions must diagnose on1.5.6; e.g. modifying CTEs, backticks and TIMESTAMPTZ_NS.

## Catalog snapshot and capability evidence

Reuse schema envelopeV2 and existing grammar-neutral drift/diff/fingerprint facilities. Add a DuckDB extension payload with canonical native logical type trees, catalog-qualified identities, type aliases/enum dictionaries/composite members/array lengths/decimal dimensions, sequences, macros and explicit application routine declarations. Do not parse nested type strings with comma-splitting or regex alone; a balanced, bounded grammar parser must handle quoted fields, nested commas, aliases and suffix arrays.

Provider sources: `duckdb_databases()`, `duckdb_schemas()`, `duckdb_tables()`, `duckdb_views()`, `duckdb_columns()`, `duckdb_constraints()`, `duckdb_indexes()`, `duckdb_types()`, `duckdb_sequences()`, `duckdb_functions()`, `duckdb_extensions()` and a small allowlist of `duckdb_settings()`. Probe shapes/gate version-specific columns instead of selecting2.0-only fields on1.4. Capture actual engine version, source hash/platform when available, loaded extension identities/versions and policy-relevant settings. Never include `duckdb_secrets()`, raw connection options, credentials or native file paths in snapshots/evidence.

Settings include timezone, default schema/search path, identifier-case policy, default collation, default NULL ordering and applicable legacy cast policy. Normalize settings that changed types in2.0 (`preserve_identifier_case` Boolean→VARCHAR); unknown values fail conservative. Extension installation is not proof of loading. Introspection must not auto-install/load optional extensions or execute macro bodies merely to discover types. Use known function overload metadata and explicit semantic manifests for null behavior/polymorphic returns; macros with unproved expansion remain unknown.

Core StructuralRelationSnapshot lacks a catalog field while schemaV2 namespaces can carry catalog. Prefer canonical full keys plus grammar extension metadata if current consumers preserve this identity correctly; otherwise add a neutral optional `catalog` field with collision/drift/packed-consumer tests. Do not collapse attached `a.main.t` and `b.main.t` into one `main.t`.

Sources: [catalog functions](https://duckdb.org/docs/2.0/sql/meta/duckdb_table_functions), [extensions](https://duckdb.org/docs/2.0/extensions/overview), [macro declarations](https://duckdb.org/docs/2.0/sql/statements/create_macro).

## Runtime behavior and supported capabilities

A buffered runtime must support `all`, `one`, `maybeOne`, execute, explicit atomic batch and callback transactions, with compiled plan preflight and consistent observer/error behavior. Native file/connection ownership is independent: closing an injected wrapper leaves the application connection/instance alive unless owned explicitly. An instance cache is application-controlled; multiple independent instances opening one path are not a connection pool.

Execution algorithm: render and validate all logical inputs/target metadata first; `extractStatements()` and require exactly one statement before preparing/running; prepare that statement; bind each value with exact physical type (including NULL/empty composites); execute; validate column names/type identity and recursively normalize native values; materialize/copied rows; release result and statement on every path. Never delegate arbitrary SQL to `connection.run()`/`runUntilLast()` because those methods execute preceding statements too.

Prepared statement objects own native handles and must have explicit destroy/close semantics. On older SDKs with no result close method, buffered consumption and deterministic resource/lifetime guarantees require separate evidence. On2.0 unread streaming results block the connection; close on consumer break, error, abort, mapper exception and return. Wait for an in-flight fetch before releasing the connection. Do not advertise cancellation/streaming merely because the SDK has method names; demonstrate cleanup/reuse.

Use a connection lease for root queries, transactions, prepared statements, streams and interrupts. A callback transaction pins one connection, rejects root/reentrant misuse, drains outstanding scope operations before COMMIT, rolls back unawaited failures, retires escaped scopes, and quarantines failed cleanup. Connection-level `interrupt()` must not cancel an unrelated operation on a reused connection; cancellation resolves only after native completion/cleanup. Deadlines have the same rule. Appenders/bulk import deserve explicit optional capability and cleanup/error tests; do not pretend every insert path is row-wise query execution.

In-process concurrency permits one process owning read-write access, or multiple read-only processes without a writer. Multiple connections in one instance can write optimistically; same-row conflicts require application transaction retry. Quack/DuckLake remote coordination is a separate integration and must not be confused with ordinary embedded file sharing. File-lock tests require separate child processes and explicit owned temporary files. See [concurrency](https://duckdb.org/docs/2.0/connect/concurrency).

Implement a live verifier with native prepared parameter and result logical types where available. Capture missing nullability/column metadata as unavailable. Do not manufacture evidence or execute statements to get metadata. EXPLAIN/plan-inspection can use existing neutral governance contracts when demonstrated; qualify server/extension settings and scrub SQL/values from proof artifacts.

## Test and release matrix: maturity evidence

| Layer | Required proof |
|---|---|
| Static grammar | Public grammar conformanceV2, exact row literal and ordered parameter tuples, diagnostic codes and UTF-16 source ranges, semantics/effects/cardinality/dependencies; grammar-specific analytical corpus |
| Version gates | Min/latest patch for each supported line;2.0-specific syntax/type gates; missing server evidence, unsupported old/new versions and prereleases conservative |
| Scalar codecs | Signed/unsigned boundaries,38-digit decimals/scale, BIGNUM, NaN/infinity rejection, BC/infinite/nanosecond times, timezone setting variation, blobs copied, JSONNULL vs SQLNULL |
| Nested codecs | Every native type nested in every supported container, empty/all-NULL lists/maps, NULL container/member, tagged NULL UNION, unnamed tuples, fixed ARRAY wrong length/dimension bounds, composite map keys and native structural equality, malicious/prototype keys and depth/node bounds |
| SQL safety | Exactly-one-statement validation before effects, comments/literals containing semicolons, wrong bindcount, duplicate columns, target mismatches, unsupported raw objects before dispatch |
| Runtime | Cardinality helpers, commit/rollback, prepared reuse/dispose, async failures, streams early break/errors, interrupt/deadline races, failed cleanup quarantine, owned vs injected lifecycle |
| Native differential | Prepared metadata vs static type plans, actual row values, logical type trees, engine version and settings; insufficient metadata reported unavailable |
| Persistence/concurrency | File reopen, process lifetime, duplicate instance lock, two connections and conflict/retry, read-only multi-process boundary |
| Distribution | Packed consumer without root driver; forbidden-driver graph; explicit adapter install on supported OS/Node lines; no native driver in `/query` browser bundle |
| Tooling | CLI snapshots/drift/init, .sql named/repeated/ordered factories, inline/structural fragments/map expansion, stable build hosts, TS bridge/language-server hover/diagnostic/completion, packaged editors and playground |
| Quality | Coverage thresholds consistent with mature grammars, scanner/resolver/compiler performance budget, docs build/local links, generated feature ledger, release manifests/Changesets/public API |

PR checks should run exact2.0.0/Neo2.0.0-r.1 and1.5.6/Neo1.5.6-r.2 plus packed Node consumer, keeping full engine/OS/Node/settings/extension matrix scheduled or manually reproducible. A full engine support line is qualified only after its complete differential matrix passes; fast PR checks are not substituted for that evidence.

## Proposed PR decomposition

1. Shared nested-value/opaque target metadata contracts and tests; no grammar semantics in core. Preserve existing PostgreSQL/MySQL/SQLite behavior and contract versions with explicit compatibility handling.
2. DuckDB package foundation: lexical profile/parser AST, full native type grammar/policy/codec identities, capability version policy and schemaV2 validation, renderer, bounded diagnostics/source mapping. Not yet a public maturity claim.
3. DuckDB catalog/introspection and generated versioned built-in/coercion evidence; schema drift and extension/macro registry. Differential engine corpus validates provider metadata across every supported line.
4. Resolver baseline and complete analytical/DML semantics: joins/CTEs/set ops/aggregates/windows/QUALIFY/nested operations/UNNEST/fixed pivots/writes/version gates; public conformance and negative diagnostics.
5. Runtime and explicit Neo adapter: typed binds, recursive codec fidelity, prepared/resource ownership, transactions/batch, cancellation/streaming and optional bulk services only after native proof.
6. Product and qualification integration: CLI/config/build/SQL files/editor/playground/examples/docs/releases/CI/packed consumers/performance, with the final feature-ledger acceptance audit against PostgreSQL/MySQL maturity.

These can be split further for reviewer size or combined where they cannot function independently, but no PR should mark issue #254 complete before the final matrix is proven. Initial scaffolding is an internal dependency, not the final new package product.
