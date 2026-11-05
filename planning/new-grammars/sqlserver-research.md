# SQL Server grammar and execution research

Internal implementation study for issue #253, inspected 2026-11-05. This is a proposed design and
qualification plan, not a public support claim. Repository baseline is main after #259–#261.

## Product and package boundaries

SQL Server is a new grammar: `@typed-sql/sqlserver`, export `sqlserver`, grammar id `sqlserver`.
`mssql` names an application-owned Node client, not the grammar. Proposed public entrypoints:

- Root: plugin, schema provider, policy, validated snapshots, catalog/type APIs, diagnostics.
- `/query`: portable renderer and `sql` export; no driver, Node builtin, parser or provider import.
- `/runtime`: driver-neutral SQL Server execution contracts, codecs, lifecycle and policy enforcement.
- `/odbc`: explicit direct `msnodesqlv8` integration for the mature exact transport, lazy driver load.
- `/mssql`: optional explicit `mssql`/Tedious integration with accurately narrower transport capability.

Do not import the PostgreSQL/MySQL parsers, use their type precedence, or build a T-SQL compatibility
mode. Existing neutral AST compatibility parser is deprecated and is not an implementation base.
Use grammar-owned parser/AST/walker/resolver/semantics. Reuse source ranges, bounded lexical toolkit,
schema v2, query fragments, compiled value plans and conformance contracts.

Maturity means the same public contracts, soundness and lifecycle evidence as PostgreSQL/MySQL,
not a promise that unrelated backend facilities are identical. Inspect `packages/postgres/test`,
`packages/mysql/test`, runtime/stream/prepared/bulk implementations, `e2e/{postgres,mysql}`, and the
package graph, distribution, docs, editor and feature-ledger contract suites.

## Version policy and exact candidates

Propose SQL Server 2017 (14.x) through 2025 (17.x), compatibility levels 140–170 where the engine
supports them. Current latest servicing references are below. Older compatibility levels can be
recorded and analyzed conservatively but are not implicitly exact. Each feature gate needs its own
engine/product/compatibility/settings rule: compatibility level alone is not an engine version.
Unknown future engine majors, malformed version strings, unknown products and unqualified preview
features remain conservative. Do not treat Azure SQL's 12.x product version as boxed SQL Server 2014.
Azure SQL Database, Managed Instance, Synapse and Fabric are separate products requiring separate
qualification and evidence before support claims.

| Engine | Default compatibility | Current servicing build reference | Qualification image candidate |
|---|---|---|---|
| SQL Server 2017 | 140 | CU31 + October 2026 GDR, 14.0.3560.2 | `2017-CU31-GDR19-ubuntu-18.04` |
| SQL Server 2019 | 150 | CU32 + October 2026 GDR, 15.0.4500.2 | `2019-CU32-GDR12-ubuntu-20.04` |
| SQL Server 2022 | 160 | CU27 + October 2026 GDR, 16.0.4305.5 | `2022-CU27-GDR1-ubuntu-22.04` |
| SQL Server 2025 | 170 | CU10, 17.0.5035.5, October 22, 2026 | `2025-CU10-ubuntu-24.04` |

Candidate tags were verified against the official MCR registry, but image-to-engine build mapping
must be asserted by the live probe, not inferred from similar tag names. Current manifest digests:

- 2017 CU31 GDR19: `sha256:aeef07e21e24e51fdbf06d6f0c3c742b50c6cb59bb9c6209c53b27513d95f50b`.
- 2019 CU32 GDR12: `sha256:07d7dedecdbfcf6776035dc5eefb5bfd9aa1804b2f6b99f7dedb397d8a599069`.
- 2022 CU27 GDR1: `sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718`.
- 2025 CU10: `sha256:245f6b1c8903edae52cb20fa31419cefcde1a49938bb8c3447099011fc871ca3`.

Supported ranges must be expressed separately from exact CI pins. These are candidates, not already
tested targets. Current 2017/2019 support is extended support; SQL Server 2016 ended ordinary extended
support July 14, 2026. Do not broaden to 2016 merely because most syntax happens to parse.

Microsoft supports these containers only on native Linux Intel/AMD x86-64. Rosetta/QEMU/Prism are
explicitly untested/unsupported. The maintainer's Apple Silicon Podman host is not qualification
evidence for SQL Server, even if emulation appears to execute. Use pinned Linux amd64 CI or a real
external server. SQL Server image EULA acceptance is explicit in the isolated test setup.

## Snapshot and semantic evidence

Preserve the canonical schema v2 envelope and grammar-owned extension facts. Read actual
`SERVERPROPERTY` ProductVersion, ProductMajorVersion, ProductLevel, ProductUpdateLevel,
ProductUpdateReference, EngineEdition and Edition; `sys.databases` compatibility_level and collation;
current database/default schema and session properties. Do not store connection secrets, hostnames
or arbitrary server output in portable evidence.

Use `sys.schemas`, `sys.objects`, `sys.tables`, `sys.views`, `sys.columns`, `sys.types`,
`sys.identity_columns`, `sys.computed_columns`, `sys.default_constraints`, `sys.check_constraints`,
`sys.indexes`, `sys.index_columns`, `sys.foreign_keys`, `sys.foreign_key_columns`, `sys.parameters`,
`sys.sql_modules`, table-type and routine catalogs. Preserve column order, native/user type ids,
precision/scale, byte versus character length, MAX, nullability, generated/identity/rowversion,
collation, encryption/masking evidence, keys/index filters and disabled/untrusted constraints.
Catalog queries must project version-specific columns conditionally: referencing a new column in an
old server query fails even if a CASE branch would not execute.

Metadata visibility is permission-scoped. A partially visible catalog must not masquerade as a
complete trusted schema. Record selected schemas and completeness diagnostics; distinguish an empty
schema from denied or missing permissions. CLR/alias/opaque types need native identity, not guessed
base types. Scalar/inline/table-valued routines retain arguments/results, volatility/determinism and
available source evidence. Encrypted modules cannot yield optimistic inferred result types.

SQL Server names are collation-dependent, including case/accent sensitivity; `[quoted]` does not
mean PostgreSQL's quoted-case rule. The shared ResolverSchemaIndex has exact table/column lookup,
but routines/functions and uniqueness helpers currently lowercase. Use grammar-owned comparison or
an explicit neutral comparison strategy. Never globally lowercase SQL Server names and silently pick
the first collision. Preserve multipart database/schema/object identity. Reject unresolved remote
four-part/linked-server names or session-local #temp objects unless explicitly declared.

Allowlisted settings affect inference and runtime compatibility: QUOTED_IDENTIFIER, ANSI_WARNINGS,
ARITHABORT, ANSI_NULLS where material, CONCAT_NULL_YIELDS_NULL, NUMERIC_ROUNDABORT, DATEFIRST,
DATEFORMAT/language, collation and database compatibility. Pin or validate the needed execution
settings on each leased connection. A snapshot's session settings do not prove an arbitrary injected
connection uses them. SQL Server 2017 fixes some historical switches to ON; don't invent variability
for settings the target can no longer change.

## Grammar and AST work

Use source-spanned local nodes for these forms, with exact negative tests rather than token skipping:

- Bracket identifiers with `]]`, ANSI double quotes with QUOTED_IDENTIFIER evidence, N-prefixed
  Unicode strings, nested block comments, `0x` binary literals, Unicode identifiers.
- Scalar bind markers distinct from `@@` system variables, `@local` declarations, `#temp` and
  `##global` objects. Query renderer must use a collision-resistant generated namespace, not `@pN`:
  node-mssql documents that its own internal drivers reserve `@p{n}`. SQL asset native named binds
  must preserve logical input grouping and lexical occurrence order. Reject unsupported DECLARE/GO
  batches rather than treating variables or batch separators as bind parameters.
- SELECT TOP expression/PERCENT/WITH TIES, SELECT aliases, derived tables, joins/full joins,
  CROSS/OUTER APPLY and correlated scopes, CTEs including recursive UNION ALL, grouping sets/rollup,
  HAVING, windows and frames, UNION/EXCEPT/INTERSECT.
- ORDER BY with OFFSET/FETCH. OFFSET requires ORDER BY; don't accept LIMIT. TOP and pagination
  legality is grammar-owned. Preserve ORDER BY alias rules and SQL Server NULL ordering.
- INSERT values/select/default-values, UPDATE FROM, DELETE FROM, OUTPUT inserted/deleted/$action
  with target/source scopes and command versus row result distinction. OUTPUT INTO is a command
  unless another statement provides rows; reject multi-result scripts in a single-row contract.
- PIVOT with explicit output names can be fixed-schema; dynamic pivot/EXEC/dynamic SQL remains
  diagnostic or unknown. MERGE needs its own AST and action-dependent output/nullability and is not
  modeled as PostgreSQL UPSERT. Ordinary DDL/procedural batches are outside the query subset and
  must fail closed, not accidentally analyze only their first SELECT.
- Table hints/OPTION hints, locking reads, temporal FOR SYSTEM_TIME, TVFs, OPENJSON WITH schema,
  STRING_SPLIT and 2025 table-valued regex functions require honest capability and semantics facts.
  Unmodeled hints cannot silently disappear from dependency/locking/volatility analysis.

The neutral lexical toolkit already supports bracket quote profiles, prefix strings and nested
comments. It lacks @named markers and #identifier prefixes; add bounded declarative modes only if
this implementation actually consumes the toolkit. T-SQL parser/AST nodes do not belong in core.
No generic AST node additions are justified just to centralize TOP/OUTPUT/APPLY.

## Coercions, built-ins and nullability

Own SQL Server native type precedence and DECIMAL precision/scale/length derivation. Do not union
incompatible branch types merely because both produce valid TypeScript. Include arithmetic integer
division/overflow, multiplication/division scale reduction, numeric literal precision, Unicode versus
non-Unicode concatenation and max-length propagation, TRY_CAST/TRY_CONVERT nullable results, CASE,
COALESCE and ISNULL (first-argument type/truncation differs), CAST/CONVERT styles and collation.

Aggregate rules differ from PostgreSQL: COUNT returns int, COUNT_BIG returns bigint; SUM/AVG return
types depend on native input family and empty aggregates are nullable. COUNT metadata is commonly
nullable even when runtime settings guarantee non-null success. Keep semantic nullability and live
metadata uncertainty explicit; don't blindly copy driver nullable flags or over-refine optional
ARITHABORT/ANSI_WARNINGS behavior. OUTER APPLY/outer joins add nullability to affected sides; recursive
CTE output can be more nullable than its anchor. JSON_VALUE lax versus strict paths, ISJSON forms,
JSON_QUERY, JSON_MODIFY and OPENJSON must retain actual behavior.

Use checked/generated versioned catalogs for common scalar/aggregate/window/TVF signatures,
coercion and volatility, not a tiny handwritten list presented as mature support. Gate 2022 additions
(GREATEST/LEAST, DATETRUNC, DATE_BUCKET, JSON_OBJECT/ARRAY, STRING_SPLIT ordinal) and 2025 additions
(JSON aggregates/native json, regex, bigint DATEADD, optional SUBSTRING length, vector facilities)
by their documented engine/compatibility/preview rules. Unknown routines diagnose or infer unknown.
Native JSON is now GA in SQL Server 2025 and is available at all compatibility levels; OPENJSON has
its separate compatibility requirement. Vector float16 remains preview on boxed 2025 and must not
inherit Azure GA status.

## Physical transport: resolved blocker and remaining proof gates

Npm inspected versions: `mssql@12.7.14`, `tedious@20.3.8`, `msnodesqlv8@6.2.2` (Node >=22).

Tedious returns bigint as lossless decimal text but decimal/numeric/money as Number. Numeric input
validation uses parseFloat. Its temporal Date has non-enumerable nanosecondsDelta, but datetimeoffset
original offset is discarded. node-mssql valueHandler runs after this decoding; String(number) cannot
recover lost precision. There is no demonstrated supported raw TDS decimal parser hook.

More importantly, `mssql/msnodesqlv8` is not automatically exact: its request valueCorrection converts
numeric strings back to Number before valueHandler, and its decimal input coercion uses parseFloat.
Its convenience wrapper must not be used as the exact path.

Direct msnodesqlv8 6.2.2 is a concrete supported alternative. Public `numeric_string: true` on query
objects / `setUseNumericString(true)` preserves decimal/numeric/money/smallmoney text, including
prepared results. Version 6.1 fixed previously truncated numeric-string and prepared-decimal paths.
Upstream tests include decimal(38,10), 9007199254740993, money bounds, negative fractions, NULL,
scale-preserving output and 120 prepared rows. This avoids modifying SELECT, DISTINCT, ORDER BY,
TOP, OUTPUT and aggregate evaluation semantics.

Direct native Numeric/Decimal input helpers still convert values to double. Bind exact decimal and
temporal values as NVARCHAR text and lower ONLY their compiled bound-value segments to a typed
`CONVERT(decimal(p,s), marker)` / `CONVERT(datetime2(s), marker, style)` etc. This is grammar-owned,
not a regex rewrite or neutral SQL wrapper. The existing SqlRenderer.placeholder(index) callback is
invoked only for bound value segments: a per-plan renderer closure can emit `CONVERT(validatedType, ?)`
for the exact text targets and `?` for ordinary values. Analyze/select the original grammar render
first, then lower the chosen plan; raw SQL text markers without bound segments are not a substitute.
Reuse a stable renderer identity per immutable plan/native-policy identity so prepared/render caches
cannot confuse native target layouts. Native metadata must be retained
in compiled parameter descriptors so string UUID, text, decimal and temporal inputs are distinct.
Reject conflicting repeated native targets unless a proven common input exists. Typed NULL and MAX/
precision/scale must not fall through to driver guessed defaults. Preserve placeholder occurrence and
source mapping across SQL-file, inline, repeated, reordered and fragment-list forms.

Both direct ODBC and Tedious Date results expose sub-millisecond nanosecondsDelta. Direct ODBC native
TimestampColumn preserves the 100ns instant components but discards original datetimeoffset offset.
A deliberate policy can expose datetime2/time wall-time canonical strings and datetimeoffset
canonical UTC instant strings with seven fractional digits. It must state UTC normalization plainly,
not claim to preserve the original offset. Use exact integer tick reconstruction and checked native
augmentation; Date.toISOString alone loses four digits. Original-offset preservation, if exposed as
a policy, needs an upstream raw/text temporal hook or separately proven exact transport path.

Policy proposal: bigint bigint|string|checked-number; decimal exact-string|Decimal-codec|explicit-
approximate-number; temporal exact canonical string|explicit Date; bit boolean; rowversion/binary
copied Uint8Array; uniqueidentifier canonical string; XML text; native/constructed JSON text or
validated parsed policy. Unsupported sql_variant/CLR/spatial/vector outputs remain opaque/unknown
until their codecs have specific proof. Do not claim parsed JSON for arbitrary NVARCHAR columns.
Native json TDS metadata can appear as varchar/nvarchar without JSONSUPPORT; catalog/native plans,
not driver field name alone, select the JSON codec.

Before exact transport is accepted, live CI must prove: decimal(38,0)/(38,38), trailing scale,
negative zero policy, money min/max, bigint signed bounds, NULL/falsy/empty values; typed exact text
inputs roundtrip without double; Date/time year 0001, 0099, pre-epoch, DST, scale0–7, leap-day,
non-hour positive/negative offsets, max year9999; malformed/absent nanosecondsDelta rejects; Date
policy precision is deliberate. Query, prepared, streaming and DML OUTPUT must use the same codecs.
Driver behavior must be verified against the pinned published package, not only mutable master.

Avoid naive SELECT text wrappers and FOR JSON transport as the default solution. FOR JSON PATH
interprets dotted aliases as nesting, chunks results, changes binary/null encoding and interacts with
JSON fragments. AUTO changes join nesting/cardinality. DML OUTPUT wrapping/table variables affects
triggers, errors and ordering. None is necessary for exact numeric direct ODBC transport, and none
can be declared semantics-preserving from a happy-path test.

## Runtime maturity and lifecycle

Implement driver-neutral buffered cardinality/execute, atomic batch and transaction callbacks,
prepared handles/cache bounds, streaming/backpressure and capability-driven cancellation/deadlines.
Retire escaped scopes, drain unawaited failures, hold exclusive connection lease for each active
request/stream/transaction/prepared owner, and never return a dirty connection to a pool. Rollback
or cancellation failures quarantine it. Commit never occurs after a pending scoped failure.

SQL Server transactions need @@TRANCOUNT and XACT_STATE evidence: an error may doom a transaction
or XACT_ABORT may roll it back automatically. Savepoints don't make nested COMMIT independent.
Default to a clear owned outer transaction; support nested/savepoints only with demonstrated behavior.
Drain all error/info/DONE tokens; distinguish result sets from row-count tokens and triggers. DML
OUTPUT may emit rows before an eventual error/rollback; don't expose them as successful buffered
results. Streaming must define error/rollback partial-row behavior honestly. Duplicate/unnamed result
columns and multiple result sets cannot be silently merged into one object-row type.

Prepared statements reserve a physical connection; finalize/unprepare on success, errors, aborts,
early stream return and database close. Test pool exhaustion, reusable/cancelled handles, concurrent
operations, callback exceptions, broken rollback and owned versus injected resource close. Don't
advertise pipeline/COPY merely because PostgreSQL has them. Expose TVP/bulk/BCP only behind explicit
capabilities and tested parameter/null/type-policy behavior. Native ODBC requires Microsoft ODBC
Driver 18, unixODBC on Unix, and supported native prebuilds/toolchain; the adapter import stays lazy.
Qualify Linux x64 with unixODBC >=2.3.12 because upstream documents dropped end-of-result warnings on
older unixODBC. Keep TLS validation defaults; trust-self-signed settings belong only to CI fixtures.

Live verifier: sys.dm_exec_describe_first_result_set / sp_describe_first_result_set plus
sp_describe_undeclared_parameters, using bound SQL text and validated parameter declaration strings.
These describe rather than execute query mutations, but have permission, temp-table, dynamic SQL and
control-flow limitations. Such cases produce uncertainty, not false verification. Optional plan
inspection uses SHOWPLAN_XML on an isolated leased connection and restores settings; never substitute
STATISTICS XML actual execution for a non-mutating plan contract.

## Required maturity matrix and implementation decomposition

1. **Qualification/prototype MR**: pinned Linux x64 engine/compatibility matrix, published direct ODBC
   transport probe, evidence artifacts, exact numeric and temporal reconstruction/input conversion.
   This is an explicit prerequisite, not an initial fake grammar package. No support claim until it passes.
2. **Neutral prerequisites MR**: only proven physical plan metadata / typed placeholder lowering and
   optional lexical profile improvements; compiler/SQL-file/selector/hash/compatibility roundtrips,
   repeated-target conflicts, bounds and existing grammar regressions. Driver semantics stay local.
3. **SQL Server grammar/schema MR**: own AST/parser/catalog/provider/version+settings evidence,
   native type policies/coercions/common built-ins, SELECT/joins/CTE/APPLY/pagination, DML/OUTPUT,
   JSON/XML basics, diagnostics/source spans, public conformance and grammar ownership contracts.
4. **Runtime/direct ODBC MR**: typed exact binding/codecs, buffer/cardinality/execute, transactions,
   atomic batch, prepared/stream/cancellation lifecycle, schema provider adapter, live verifier/plan
   inspector, real-server and packed-consumer evidence. Optional mssql adapter may be a distinct MR
   and must fail before incompatible lossless policy dispatch; it is not the only mature runtime.
5. **Product integration MR**: CLI init and build-host SQL assets/inline queries, language server and
   editor packaged artifact matrix, playground schema/query examples, canonical quickstart/reference/
   compatibility/limitations and sidebar/docs contracts, feature ledger, public API/distribution,
   Changesets/release manifest/performance budgets. Root/package READMEs remain concise links.
6. **Cross-validation/promotion MR**: complete inference/ordered binds/ranges/native server result
   tests across supported engine majors and compatibility gates, statement mutation/negative corpus,
   randomized coercion/native-type cases, E2E native and SQL-file parity, dependency forbidden-driver
   and no-preview boundaries, full verify/coverage/pack/performance. Public exact claims follow this evidence.

Minimum representative engine matrix: every claimed major at its default level; SQL2025 at140/150/
160/170 to catch engine-vs-compatibility mistakes; feature gate boundary levels (OPENJSON below130 as
negative/conservative target), versionunknown/nextmajor/prerelease, case-sensitive/insensitive and
Unicode-sensitive collation cases, ANSI_WARNINGS/ARITHABORT and quote/date setting mismatches. PR CI
has a bounded native engine representative plus codec unit/grammar conformance/packed gates; scheduled
matrix retains every claimed major. CI artifacts record actual server build, edition, compatibility,
settings, ODBC/native driver versions, image digest, Node version and each test layer's results.

## Primary sources consulted

- [Microsoft supported SQL Server versions/lifecycle](https://learn.microsoft.com/en-us/sql/sql-server/end-of-support/sql-server-end-of-support-overview?view=sql-server-ver17).
- [SQL Server 2017 build list](https://support.microsoft.com/en-us/servicing/sql/sql-server-2017/kb4047329-build-versions).
- [SQL Server 2019 build list](https://learn.microsoft.com/en-us/troubleshoot/sql/releases/sqlserver-2019/build-versions).
- [SQL Server 2022 build list](https://support.microsoft.com/en-us/servicing/sql/sql-server-2022/kb5023451-build-versions).
- [SQL Server 2025 build list](https://support.microsoft.com/en-us/servicing/sql/sql-server-2025/kb5005684-build-versions).
- [Official MCR tags](https://mcr.microsoft.com/v2/mssql/server/tags/list).
- [Compatibility levels](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level?view=sql-server-ver17).
- [Container support and x86-64 requirement](https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver17).
- [SQL Server 2025 features](https://learn.microsoft.com/en-us/sql/sql-server/what-s-new-in-sql-server-2025?view=sql-server-ver17).
- [Native JSON/driver TDS limitations](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type).
- [COUNT return/nullability/overflow rules](https://learn.microsoft.com/en-us/sql/t-sql/functions/count-transact-sql?view=sql-server-ver17).
- [COALESCE versus ISNULL](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql?view=sql-server-ver17).
- [Catalog column metadata](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-columns-transact-sql?view=sql-server-ver17).
- [First result description](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-first-result-set-transact-sql).
- [Undeclared parameter description](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-undeclared-parameters-transact-sql).
- [node-mssql public driver docs and reserved names](https://tediousjs.github.io/node-mssql/).
- [Tedious wire parsing](https://github.com/tediousjs/tedious/blob/master/src/value-parser.ts).
- [Tedious numeric input validation](https://github.com/tediousjs/tedious/blob/master/src/data-types/numeric.ts).
- [node-mssql ODBC coercion](https://github.com/tediousjs/node-mssql/blob/master/lib/msnodesqlv8/request.js).
- [Direct msnodesqlv8 numeric fixes](https://github.com/TimelordUK/node-sqlserver-v8/releases/tag/v6.1.0).
- [Current msnodesqlv8 release/platform/warning caveats](https://github.com/TimelordUK/node-sqlserver-v8/releases/tag/v6.2.2).
- [Published-version exact numeric tests](https://github.com/TimelordUK/node-sqlserver-v8/blob/v6.2.2/test/params-complete-refactored.test.js).
- [Native temporal representation](https://github.com/TimelordUK/node-sqlserver-v8/blob/v6.2.2/cpp/include/js/columns/timestamp_column.h).
- [Native temporal conversion](https://github.com/TimelordUK/node-sqlserver-v8/blob/v6.2.2/cpp/src/js/columns/timestamp_column.cpp).
- [Native input binding implementation](https://github.com/TimelordUK/node-sqlserver-v8/blob/v6.2.2/cpp/src/core/bound_datum.cpp).

Evidence downloaded for inspection is ignored under `artifacts/sqlserver-research`. Generic IBM
`odbc@2.6.0` was also investigated: it returns temporal strings, but its current native result code
converts DECIMAL/NUMERIC via Number/atof, so it is not an automatically lossless replacement.

### Native macOS adapter detail

The published6.2.2 tarball includes `prebuilds/darwin-arm64/msnodesqlv8.node`; inspected `otool -L`
links to `/opt/homebrew/opt/unixodbc/lib/libodbc.2.dylib`. Apple Silicon application support requires
that native library plus Microsoft ODBC18 and a real external SQL Server. It does not permit
qualifying an emulated local SQL Server image. Other platforms without a published prebuild need
an explicit source-build qualification; do not infer binary availability from generic README text.

[Microsoft native macOS ODBC setup](https://learn.microsoft.com/en-us/sql/connect/odbc/linux-mac/install-microsoft-odbc-driver-sql-server-macos) confirms ARM64 support from17.8 onward and Homebrew unixODBC requirement.
