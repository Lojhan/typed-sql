# Query-contract implementation evidence

The objective is the complete [final specification](./spec.md) and a stable, reviewable PR.
This ledger records intermediate evidence; it does not reduce the target to the implemented subset.

## Reproposal

PR #280 is reframed around query contracts, hybrid inference and explicit native qualification.
The preceding catalog acquisition, independent native auditing and regression fixes remain
supporting work. The final specification and measured bundle baseline are committed separately.
Unrelated planning work is left unchanged.

## Initial implementation

- Added the neutral `@typed-sql/analysis` package with core/schema dependencies only, stable
  release-track registration and no driver, compiler or preview integration dependency.
- Added bounded, data-only canonicalization, exact SQL digests and context identities binding
  grammar/profile/schema/database/policy/codec/interpreter revisions.
- Added content-addressed query contract construction, validation, serialization and an immutable
  index. Conflicting records for identical inputs fail instead of selecting the newest record.
- Contract application types derive from validated runtime descriptors; cached arbitrary
  TypeScript source is not accepted. SQL-relative column spans rematerialize current ranges.
- Added a synchronous contract dialect over an explicit lightweight profile. Missing contracts,
  changed schema/policy and unqualified repeated-result invariance yield conservative diagnostics.
- A contributed `vendor/graph` fixture compiles an otherwise unknown function through the existing
  compiler and checks row/parameter types, generated value plans and runtime decoding without
  importing a full grammar analyzer. This is synthetic evidence, not a native acquisition result.
- Added explicit durable closure export/import: bounded reads, digest-validated contexts and query
  objects, immutable object publication and atomic manifest replacement. Export never deletes old
  objects; loading consumes only the declared closure, with no disposable-cache fallback.
- Persistence tests cover deterministic export, concurrent publication, replacement, corruption,
  missing objects, context mismatch and manifest traversal rejection. Synthetic disconnected
  consumption passes; this is not yet a physically isolated packed-consumer proof.
- Focused package coverage passes with 100% lines/statements/functions and 95.36% branches.
  Quality and full typechecking pass. The contract suite passes 67 files; its remaining release
  note check passes after correcting the new package changelog to Unreleased. Package graph,
  documentation, public API and packed editor checks are included in that evidence. Full
  repository verification and native acquisition remain open.

## Native acquisition foundation

- Added independently validated native evidence: adapter revisions, consistency scope, result
  kind, sanitized descriptors, exact parameter occurrences and separate known/unknown native
  identity, runtime representation and nullability facts. Partial native identity survives
  contract consumption; unknown nullability becomes conservatively nullable.
- Added explicit async acquisition over grammar-owned sessions. Statement acceptance precedes
  opening a connection; candidate data is snapshotted and frozen. Expected context is checked
  before and after description, parameter slots/layout and adapter revision are validated,
  unresolved parameter evidence is rejected, and sessions close on every outcome.
- Native evidence and runtime plans must agree even after an artifact digest is recomputed.
  Parameterized native hits require the lightweight profile to attest the same occurrence layout.
- Synthetic adapter tests cover independent acquisition, persistence/reload, partial facets,
  descriptor limits/validation, context drift, cancellation, failed cleanup and caller edits.
  These are neutral mechanics tests, not proof of any built-in transport or native consistency.
- Core parameter collection, compiler manifests and existing verification preserve explicitly
  partial native identity. Incomplete modifiers cannot earn an exact-identity verification claim;
  independent representation/nullability mismatches remain visible.
- Analysis coverage passes with 100% lines/statements/functions and 96.87% branches. Typechecking,
  focused package/API/documentation boundaries and quality pass for the acquisition foundation.
- Real adapter ownership, strict native/static reconciliation and the native vertical remain open.

## Required work still open

1. Complete the contract/evidence model: native descriptors and provenance, reusable/facet-specific
   qualification, parameter authority/layout, result kinds and scoped semantic facts.
2. Native acquisition independent of resolved compiler manifests, registered owners and strict
   project-wide native qualification, including disagreement handling.
3. Real database vertical proof with compiled decoding and disconnected reuse; qualify the five
   engine/transport profiles and explicit limitations.
4. Durable contract closure export/import and a clean frozen consumer with analyzer modules and
   global catalogs physically absent. The initial in-memory consumer alone does not prove this.
5. Disposable cache persistence, ownership, atomic publication, corruption/limit handling,
   cross-process locking, pruning and context-aware invalidation.
6. Explicit offline/frozen/live configuration and CLI generation/check/watch operations.
7. Race-safe live scheduling, cancellation/backoff, editor/project invalidation and restart reuse.
8. Finite/repeated structural variant coverage, ambiguous/repeated parameters, unsupported syntax
   fallback and conservative runtime effect/routing behavior.
9. Built-in lightweight profile/runtime entrypoint migration, selected core/profile/pack loading
   and compatible/breaking API transition. Preserve existing supported semantics explicitly.
10. Optional project catalogs and contributed extension reuse behind qualified inference permission.
11. Public documentation, diagnostics, release/distribution contracts and after-implementation
    bundle/latency/workload measurements.
12. Full repository/native/packed/editor/performance gates, review resolution and a requirement-
    by-requirement audit of all acceptance scenarios before marking the objective complete.
