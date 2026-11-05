# DuckDB reviewer cross-validation

Reviewed 2026-11-05 against `implementation-plan.md`, `shared-architecture.md`,
`sqlserver-research.md`, current core/compiler/query source, actual Neo1.5.6/2.0 probes,
and official DuckDB documentation/source. This is an internal design review.

## Readiness verdict

The architecture is ready for staged implementation **after** the concrete version decision and
SQL Server structural parameter-lowering method below are incorporated in the master plan.
The research does not itself prove either unpublished package mature. SQL Server exact transport
still needs native Linux-x64 server qualification; DuckDB actual engine probes already establish
critical nested/precision/metadata/lifecycle facts but are not the complete acceptance suite.

The plan correctly requires all product layers and keeps unsupported dynamic behavior fail-closed.
The shared object/tuple/array-length contract is appropriately neutral and enough for DuckDB native
values; a separate global SQL MAP/UNION enum or schema format is unnecessary.

## Objections and dispositions

| Finding | Severity | Required disposition / resolution |
|---|---|---|
| Master DuckDB version paragraph still leaves1.4/floor undecided | Plan blocker | Agreed recommendation is full initial integration at exact engines1.5.6 and2.0.0, SDK1.5.6-r.2 and2.0.0-r.1. Explicit disjoint qualified windows; no promise of1.5.0–1.5.5, unknown1.6–1.9 or futurepatch.1.4.5 is unsupported, not a broken existing promise. Companion DuckDB report updated. |
| Neo capabilities differ within an engine support family | High | Real1.5.6-r.2 probe confirms prepared columns, parameter metadata and closeSync; older1.4 SDK lacks them. Do not claim identical closure/metadata/streaming from an engine version alone. Master should name both qualified SDKs, not describe all old bindings as metadata-less. |
| SQL Server exact input conversion could drift into blind runtime SQL rewrite | High | Use the existing renderer's structural value-segment boundary; see concrete proposal below. Never regex-rewrite arbitrary rendered SQL, wrap a SELECT, or emit unvalidated databaseType text. Native proof and original-AST parameter semantics remain mandatory. |
| Changing native parameter targets while reusing a prepared skeleton can silently retain old CONVERT | High | Prepared cache identity must include physical target plan/policy or use a stable per-plan renderer identity. A query with identical text/logical TS type but changed DECIMAL precision/scale or datetime target cannot hit an incompatible cached skeleton. Add explicit negative reuse tests. |
| MAP keys are not ordinary JS object keys/reference identities | High | Default ordered typed key/value tuples approved. Actual2.0 accepts LIST keys with NULL elements, STRUCT keys with NULL fields, UNION keys and MAP keys; rejects outer NULL keys and structurally duplicate LIST keys containing NULL. Test structural SQL equality in codec validation or reject an unproved key family before dispatch, not stringify keys. |
| Fixed ARRAY dimension constraints differ from generic core lengths | Medium | Actual2.0 and1.5.6 probes rejectzero/negative and sizes above100,000 per dimension. Core length remains a generic bounded nonnegative safe integer; DuckDB applies native1..100,000 bounds. Preserve multidimensional suffix ordering; exact length belongs in runtime validation. |
| SDK convenience conversion is not our exact policy | High | Neo JS converter turns DECIMAL into double and temporal values into Date; do not use getRowsJS as default. Recursive native wrapper normalization plus exact grammar codecs is required. |
| Native temporal wrapper toString has mutable global timezone dependence | High | Neo timestampTZ formatting reads DuckDBTimestampTZValue.timezoneOffsetInMinutes, unrelated to DuckDBTimeZone. Do not mutate global SDK statics or trust host timezone. Canonical exact temporal formatter must derive deterministic output from native ticks/parts and represent infinities/range/precision explicitly. |
|2.0 VARIANT support is incomplete, not uniformly unreadable | Medium | Actual SELECT1::VARIANT can be read; upstream bug concerns logicaltype construction/binding. Diagnose/unknown unprovedVARIANT contracts without incorrectly claiming all result retrieval impossible. |
| Snapshot catalog qualification can collide | High | Prove that existing fullkeys plus grammar extensions survive drift/serialization/tooling with two attached catalogs containing main.t. If not, add neutralcatalogfield deliberately. Do not flatten catalog into schema spelling and hope consumers retain meaning. |
| PIVOT/dynamic external schemas must remain dynamic despite native describe success | High | Native describe is differential evidence only. Do not execute/read arbitrary files at build time, or freeze a data-dependent pivot merely because one live prepare reports columns. Fixed declared domains or explicit stable schemas are necessary. |
| Typed physicaltarget metadata can become a SQL injection channel | High | Bound string size/total metadata, canonicalize, grammar-parse/allowlist types, then generate SQL only from parsed type nodes. Do not treat a core-validated string as trusted SQL. Child native targets can be reconstructed from one top-level native type expression. |
| Repeated arguments with sameTSstring can have incompatible native meaning | High | Existing SQL-file comparisons already include databaseType/runtimeType; retain them. Extend ParameterCollector conflicts. Prove matching targets for every occurrence, or diagnose/prove a common input policy; never first occurrence wins. |

## Concrete SQL Server lowering candidate

Current core `SqlRenderer` has `placeholder(index)` and `quoteIdentifier(name)`. In
`packages/core/src/query.ts`, `compileRenderSkeletonSegments()` calls `placeholder()` **only for a
bound value segment**, never for a string/comment/identifier/raw text occurrence. This is a useful
existing boundary: no new generic SQL rewrite API is automatically necessary.

A SQL Server adapter can construct a grammar-owned renderer for the current immutable value plan:

```text
placeholder(index):
  inspect canonical, grammar-validated native target for this parameter
  if exact transport needs NVARCHAR binding:
    return CONVERT(<generated validated target>, <generated marker>, <validated style if needed>)
  otherwise:
    return <generated marker>
```

The plan's native target must come from analysis of the original AST and its native parameter
contract, including ISNULL first-argument types, DECIMAL promotion and temporal semantics. The driver
binds the associated canonical exact text as data. This changes only the physical representation of
that parameter value to recover the original intended native type; it does not cast columns, wrap
projections, alter DISTINCT/ORDER BY/TOP/OUTPUT, or inspect SQL strings for marker replacement.

This remains a candidate until real ODBC tests prove semantics for SELECT expressions, predicates,
CASE/ISNULL/COALESCE, INSERT/UPDATE/DELETE OUTPUT, typed NULL, high precision/time, explicit casts,
repeated/reordered names and mapped/conditional fragment lists. Unsupported syntactic positions must
fail before dispatch if wrapping a scalar expression is not legal there. The target/policy must be
part of render/prepared cache identity, and compilation/live-verify/plan-inspection fingerprints must
state whether they refer to logical/original or physical/lowered SQL. Arbitrary rawSQL markers that
are not represented by structural value segments are not made safe by this technique.

## Cross-review of other design choices

- SQL Server keeping grammar id `sqlserver` while naming the driver subpath `mssql` is correct.
  Reserved driver marker names, OUTPUT row/command distinction, COUNT versus COUNT_BIG, rowversion
  binary, collation-dependent names, settings evidence and partial catalog visibility are covered.
- Direct ODBC numeric-string output is a plausible exact transport rather than coercing rounded
  Tedious/mssql values back to strings. Native temporal nanosecondsDelta and original offset loss
  remain real-server qualification requirements, not facts to infer from one C++ source function.
- Optional mssql compatibility path must reject an incompatible exact plan before executing any
  statement. It cannot substitute a narrower approximate transport for the requested mature default.
- Generic object fields should be required own data properties; nullable never means missing. MAP
  and UNION outputs remain native types with nested bigint/bytes; using JSON shapes would be wrong.
- Normalization belongs in the adapter recursively; changing top-level normalizeValue semantics
  globally is unnecessary regression risk. Existing PG/MySQL/SQLite behavior remains a gate.
- Root-only bounded databaseType metadata is enough for both current prototypes. A bigger opaque
  transport registry should be added only if concrete exact codecs cannot be selected from it.
- Full product acceptance correctly includes CLI, SQL assets/inline transforms, prepared variants,
  editors/playground, packed consumers, performance, feature ledger, docs and release manifests.
  These are required final work, not optional follow-up polish after parser scaffolding.

## Implementation gates

Proceed with P0 and shared N1 once these dispositions are reflected in the master plan.
Parallel package work is appropriate after shared shapes are stable. Before labelling the packages
mature, rerun a requirement-by-requirement audit against issues253/254 and maturity-audit.md with
actual native engine artifacts, packed applications and unchanged existing grammar tests.
