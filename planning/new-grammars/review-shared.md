# Shared architecture cross-review

Reviewer: shared-architecture agent. Date: 2026-11-05.
Reviewed `implementation-plan.md`, `maturity-audit.md`, `sqlserver-research.md`,
`duckdb-research.md`, and the current core/compiler/schema/AST implementation.

## Verdict

The design is ready for implementation once the master plan incorporates the decided DuckDB
version policy and records the resolutions below. There is no justification for a new general SQL
AST, a core dialect switch, a codec callback registry, a multi-result Query API or a schema v3.
Start shared implementation only after root finalizes this review record. Exact driver and complete
package maturity claims still require the planned live qualification; research is not that proof.

## Objections and resolutions

| Review objection | Evidence and resolution | Status |
|---|---|---|
| Broad DuckDB interval could imply nonexistent/unqualified minor lines, and 1.4 lacks mature resource lifetime APIs | DuckDB study now pins disjoint exact engines 1.5.6 and 2.0.0 with Neo 1.5.6-r.2 and 2.0.0-r.1. 1.4 is an unsupported negative target. Update the master plan's old “floor under review” paragraph. Future versions conservative until qualified. | Resolved design; master text update required |
| Native nested values could be mislabeled JSON | Generic required objects, positional tuples and optional fixed-array length suffice. MAP is ordered typed entry tuples; native UNION uses literal-tagged object alternatives. Bigint/bytes and independent NULLs survive. No new SQL-specific core opcode. | Resolved |
| Nested nullability could be dropped during normalization | RuntimeValueField carries `type` plus `nullable`; nullable outer object/array is separate. Missing fields are errors, not NULL. Active tagged NULL differs from SQL NULL. Existing JSON ambiguity traversal must recurse through every new child. | Resolved; tests required |
| Prototype-key rejection would exclude valid SQL identifiers | Preserve `__proto__`, `constructor` and similar names as safe own data properties. Never use inherited lookup or assignment that mutates prototypes. Reject descriptor accessors/custom prototypes/cycles; copy values into owned containers. | Resolved |
| Opaque native metadata could turn into SQL injection | Core only stores bounded `databaseType` text. Grammar adapter must parse and canonicalize allowed target types before `CONVERT`; metadata is never a trusted SQL fragment merely because its length is valid. | Resolved; negative tests required |
| Physical type metadata currently disappears | `compiler/src/value-plan.ts` drops resolved databaseType. Add root-only QueryValueDescriptor.databaseType; DuckDB native type syntax recursively describes child bind targets, so no nested SQL metadata field or arbitrary callback is needed. | Resolved |
| Existing repeated-argument checks were understated | `compiler/src/sql-file-analysis.ts` already compares databaseType, runtimeType, JSON, scalar JSON and JsonInput permission. Preserve them. `core/src/resolver.ts:ParameterCollector` still does not compare conflicting runtimeType; strengthen that specific gap. | Resolved |
| Plan compatibility with an older core could lose physical binding facts | Old copyType rejects new object/tuple variants, but old copyDescriptor can silently omit a new databaseType on primitive plans. New package dependency ranges must require the shared change; grammar runtimes reject missing required native targets before dispatch. Do not silently guess DECIMAL/typed NULL targets. | Resolved; packed compatibility test required |
| SQL Server exact decimal defaults were impossible through stock mssql | Direct msnodesqlv8 >=6.2.2 numeric_string mode is the proposed exact path, independent from mssql's lossy valueCorrection wrapper. Public upstream tests are useful evidence but must be repeated on our pinned native x86-64 CI. Never stringify a rounded Number. | Resolved design; live qualification mandatory |
| Exact SQL Server inputs require casts without changing result semantics | Bind exact canonical text. Compile-time grammar analysis verifies parameter contexts; runtime can use an existing per-selected-plan SqlRenderer.placeholder closure to emit typed CONVERT with allowlisted target/style only for structural value segments. Preserve evaluation, lexical value order, source ranges and repeated binding metadata. No runtime AST scan, SELECT/FOR JSON wrapper or neutral regex rewrite. | Resolved design; live qualification mandatory |
| ODBC marker spelling differs from named T-SQL markers | Direct ODBC uses positional `?`; portable SQL can use generated @ names. A grammar-owned renderer maps structural value segments to `?` while preserving values. Reserved/internal @pN names and @locals/@@system remain parser concerns. | Must be asserted in SQL Server adapter tests |
| Temporal strings could overpromise offset retention | Canonical datetimeoffset UTC instant text can preserve 100ns ticks while explicitly discarding original offset. Reconstruct using checked SDK augmentation; prove year 0001/0099, pre-epoch, scale and offset cases. Date.toISOString alone is insufficient. | Resolved design; live qualification mandatory |
| Existing resolver lowercase behavior could fabricate names | SQL Server collation and DuckDB ASCII-only case folding belong to their own name lookup. Canonical catalog-qualified keys and extension evidence retain identity; no global lowercasing or schema flattening. | Resolved |
| Multiple result sets could silently become Query<Row> | Ordinary query execution must have exactly one declared row shape; diagnose/reject unsupported procedural/batch output or expose explicit namespaced capability. Row-count tokens are not separate rowsets. | Resolved |
| Research scope could become a scaffolding-only delivery | Master outcome and complete matrix explicitly require grammar, provider/policy/runtime/tooling/docs/packed/live qualification at existing maturity, with implementation continuing through all MRs. | Resolved |

## Concrete N1 contract

```ts
export interface RuntimeValueField {
  readonly type: RuntimeValueType;
  readonly nullable: boolean;
}
// Extend RuntimeValueType:
// | { readonly object: Readonly<Record<string, RuntimeValueField>> }
// | { readonly tuple: readonly RuntimeValueField[] }
// Existing array member gains readonly length?: number.
// Existing top-level QueryValueDescriptor gains readonly databaseType?: string.
```

Object fields are required and exact; reject unexpected own fields rather than retaining unverified
values or silently stripping payload. Tuple entries are exact-length, ordered and independently
nullable. Core can express an empty tuple/zero-length array as general logical JS; each grammar
rejects native shapes its engine disallows. DuckDB's observed ARRAY dimension must be positive and
its engine maximum must be gated/qualified separately.

Descriptors use bounded own-data/plain-object inspection, not getters. Apply existing depth, node,
field/tuple expansion limits to each new branch. Native metadata needs per-string and aggregate text
budgets so many small descriptors cannot allocate unbounded type strings. Preserve all allowed SQL
field names using safe own-property construction. Input/output container copies do not leak mutable
SDK wrappers. Prototype or accessor tests cover both descriptor normalization and value traversal.

A nested JSON descriptor retains its JSON-null/SQL-NULL distinction, including nullable object fields
and tuple slots; do not make new container code bypass ambiguousParsedJson or scalar's JSON path.
All descendants are included in bigint transport preflight before any executor is invoked.

No change to the profile's normalizeValue callback semantics is required: grammar adapters recursively
unwrap SDK-specific structures before logical validation. Native typed parameter construction belongs
to the grammar runtime, which can inspect getQueryValuePlan, validate logical inputs and encode exact
SDK values. Do not extend generic buffered executors just to thread one driver's type objects through.

SQL text fingerprints should remain SQL identities. Physical descriptor equality/selection/artifact
serialization must retain metadata. A SQL Server prepared cache additionally keys physical target,
policy and lowering revision because the native SQL can include CONVERT even when portable SQL stays
identical; do not reuse a handle under a different target. Keep logical source fingerprints and native
execution identities distinct rather than arbitrarily changing core SQL fingerprint semantics.

## MR ownership and validation

Recommend **N1 and N2 as separate MRs**, with N2 conditional rather than speculative. N1 is a coherent
core/compiler contract change with no dependency on lexical extensions. A lexer change is not needed
to prove object/tuple/native metadata and can be reviewed independently against the grammar parsers.

N1 owns:

- `packages/core/src/query-value-plan.ts`, `types.ts`, `resolver.ts`, `index.ts` and their focused tests;
- `packages/compiler/src/value-plan.ts` plus compiler/SQL-file/selector propagation tests;
- core/compiler Changeset and public API/packed consumer assertions directly required by new exports.

Root owns broader release manifests, docs and integration contracts; new package agents own their
parser, catalog, native type parser, codecs, runtime and driver adapters. Coordinate any shared test
fixture paths before editing them. No vendor SDK dependency is added to core/compiler.

N1 meaningful tests:

1. Synthetic public grammar emits STRUCT-like object, tuple, fixed array, tagged object union and
   databaseType metadata through inline and SQL-file compilation into executable plans.
2. Encode/decode nested bigint/bytes/JSON and NULL containers/members, empty values, exact lengths,
   readonly/owned copies; missing/extra fields and wrong tags fail with useful paths.
3. Safe-number transport rejects nested bigint before an instrumented executor dispatches; physical
   target survives selectors and repeated cardinality expansion without touching parameter values.
4. Repeated same logical TS type with conflicting native descriptor fails, while compatible repeated
   named/numeric contexts retain current behavior. Existing SQL-file guards continue passing.
5. Descriptor/value accessors, hostile prototypes, valid prototype-like SQL keys, cycles, deep/wide
   types and metadata text budget overflow fail safely without invoking getters or mutating prototypes.
6. Packed consumer validates new public entrypoints/exports and old-grammar regressions. Existing
   PostgreSQL array/JSON, MySQL transport, SQLite, selector, result-stream and schema-policy tests pass.
7. Run relevant core/compiler coverage gates, typecheck, quality, pack and full verify/performance
   gates before publishing this shared prerequisite. Exact native driver proof belongs to S2/D2,
   where actual wrappers and typed binds are exercised; do not claim that logical unit tests alone
   establish SQL Server or DuckDB transport compatibility.

N2 owns only `packages/ast/src/toolkit/{types,tokenizer}.ts`, toolkit tests, any public synthetic
profile proof, Changeset and performance assertion strictly needed by its new lexical primitives.
Named markers, identifier prefixes or dollar strings are added only after concrete parser use cases
are agreed. SQL Server/DuckDB AST nodes, keyword sets, precedence and grammar errors stay outside AST.
N2 must retain exact source reconstruction, UTF-16 ranges and parser allocation budgets; it never
implements a vendor selector or parser syntax mode.

## Final readiness conditions

P0 can finalize after root updates the master DuckDB decision and records each agent's review.
N1 can then start in its isolated worktree using the concrete minimal contract above. S/D package
work can parallelize against the agreed interface while exact native CI qualification proceeds.
Open live-proof requirements are implementation acceptance gates, not excuses to shrink the product
or claim support prematurely. No additional core architecture work is required before those proofs.
