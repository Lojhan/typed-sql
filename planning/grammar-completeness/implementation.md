# Grammar generation implementation evidence

The objective is the full specification in [spec.md](./spec.md), with a merge-ready PR. Partial
checkpoints below do not establish completion. Shared infrastructure must use registrations,
never grammar-name branches. Engine and extension meanings belong to their contributions.

## Current checkpoint

- Working PR: [#280](https://github.com/Lojhan/typed-sql/pull/280), kept in draft during migration.
- Added a mapper registry with external grammar and inherited contribution support.
- Migrated legacy routine extraction and version-band selection to registered mappers.
- Kept the existing capture envelope byte-compatible: all retained signatures still validate.
- Normalized SQLite native integer fields in shared views without rewriting capture evidence;
  the four 3.53.4 contexts now share 162 complete function registrations instead of zero.
- Removed physical-storage-based SQL Server alias inference. Explicit SYSNAME alias evidence
  remains policy; native dimensions are still generated. Unqualified VECTOR is unknown.
- Added declaration versus CAST/CONVERT length context, with grammar-owned regression witnesses.
- Added public, grammar-neutral `bindRoutineArguments` mechanics in core. PostgreSQL now uses
  this contract while keeping native type binding, casts and overload ranking grammar-owned.
- Removed the corpus's closed grammar-name allowlist and made mapper injection available across
  capture import, validation, persistence and grouping. A synthetic graph contribution exercises
  that full round trip. SQL Server's disposable-database identity rule belongs to its mapper.

## Validation observed

- `pnpm typecheck`: passed after including the private tool sources in the contract-test project.
- SQL Server tests plus catalog generation, mapper and language audit contracts: 26 files passed.
- `pnpm quality`: passed, including deterministic catalog checks and all 17 reference targets.
  Existing SVG style warnings remain non-blocking and are outside this implementation.
- Core package tests: 22 files passed; the new argument-binding module has 100% statement,
  branch, function and line coverage, and package coverage thresholds pass.
- Public API and PostgreSQL native signature tests pass.
- Packed consumer test passes with the new binder imported from the compiled public core
  entrypoint in an isolated driver-free installation.
- Documentation contracts pass. The performance gate passes in an isolated run without budget
  changes. A preceding run during concurrent packaging failed the scanner budget and is not
  used as performance evidence; both logs remain in local artifacts.

## Requirements still open

1. Independently decoded native type identities and modifiers; remove shared implementation
   normalization from the expected side of native comparisons.
2. Complete validated IR, provenance/source locks and field/projection-loss accounting.
3. Pinned structured source extraction for every declared engine/version/profile.
4. Full signature/type/keyword/operator/cast/syntax generation, including special invocation
   forms, generic constraints, named/default/variadic arguments and table outputs.
5. Grammar-owned semantic rule migration and real runtime/inference mapping integration.
6. Independent category-specific live qualification, generated invocation classes, retained
   regression witnesses, explicit gaps and blocking required native lanes.
7. Extension contribution captures/qualification and third-party packed-consumer proof.
8. Explicit analysis entrypoints/preloading and documented breaking root API transition.
9. Offline deterministic build/typecheck bootstrap, disposable executable generated code and
   correct compiled npm/editor artifacts.
10. Coverage ledger migration, current missing-feature documentation and public qualified scope.
11. Full repository/native/packed/editor/performance verification, PR review resolution and
    final requirement-by-requirement completion audit.

This list preserves the full goal. It is not a reduced definition of ready-to-merge.
