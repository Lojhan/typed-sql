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
- Added the executable v2 model schema, inferred static types, content-addressed entities,
  profile/source references and a loss-preserving legacy importer. Generation now consumes
  that validated projection instead of independently normalizing raw rows.
- All 33 retained contexts import into 26,829 normalized entities and 164 source records.
  Every source category and raw-row reference is accounted for by contract tests. Native
  payloads, formal/default/output metadata and unresolved provenance are preserved.
- Profile-specific variants and unavailable evidence retain explicit membership. Generated
  schema and normalizer/input digests participate in the generation evidence.
- Moved catalog emission behind registered grammar owners. Shared generation has no grammar-name
  dispatch, validates all output ownership before writes, stages replacements and writes reports
  last. Per-output hashes and an artifact fingerprint record executable projection bytes.
- Consolidated legacy PostgreSQL/MySQL generators into the pure Node offline pipeline. Build and
  typecheck generate before compilation. Required endpoints derive from the feature ledger.
- Removed DuckDB's generated-parser bootstrap dependency by interpreting captured aliases in its
  generator. PostgreSQL/MySQL core catalogs now use statically checked object literals instead
  of unchecked assertions or runtime JSON parsing. This is relocation/consolidation, not claimed
  removal of maintained semantic policy.
- Added a clean-room generation/check contract without grammar implementation sources or prior
  outputs, external-emitter ownership/error contracts, and executed catalog revision checks.
- SQLite global namespace knowledge is explicit mapper policy. DuckDB pragma set-return knowledge
  remains unknown where the native evidence does not establish it.
- Replaced host-parser normalization on both sides of native type comparisons with independent
  engine descriptions of claimed types. Registered description owners preserve PostgreSQL
  OIDs/typmods, DuckDB nested structure/branding and SQL Server logical names/dimensions/user type
  identities. Shared comparison has no grammar-name branches. Missing parameter descriptions now
  prevent a complete identity claim even when parameter counts match.
- Registered audit adapters now own analysis construction, tokenization, version selection and
  invocation planning. Shared audit/recognition code no longer imports grammar implementations
  or selects behavior by engine name. Injected registries support new/inherited grammar IDs;
  a graph contribution exercises inventory, parameterized native probes and independent comparison.
- Reused neutral registry validation with explicit stage method contracts. Extension preserves
  frozen registrations even if a caller mutates its original definition after registration.
- SQL Server expected-type evidence validates numeric descriptor fields returned as decimal text.
  Its independent owner recognizes Microsoft's documented DECIMAL/NUMERIC logical equivalence,
  preserving precision, scale, logical names outside that equivalence and user type identity.

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
- The preceding published checkpoint `984e1fde` passed CI run `42380744391` and migration
  integration run `42380744338`. Those results do not qualify subsequent working changes.
- V2 model/import tests pass, including corrupted references, unsupported/non-JSON values,
  cyclic metadata and external contribution round trips. The generated draft-07 schema also
  compiles under the separately installed Ajv 8.20.0 validator.
- After the model integration, `pnpm typecheck`, `pnpm quality` and all 50 repository contract
  test files pass locally, including package graph and isolated packed consumers/editors.
- Model checkpoint `6ef2a2bd` passed CI run `42382870026` and migration integration run
  `42382870015`.
- After registered emission and offline CLI consolidation, typecheck, quality, all 52 contract
  files and PostgreSQL/MySQL package tests (including coverage gates) pass. The performance gate
  also passes in isolation. These are local results; the next pushed head needs its own CI.
- Emission checkpoint `fe795982` passed CI run `42385784130` and migration integration run
  `42385784108`.
- Independent type-description comparison passed focused contracts and local native audits on
  PostgreSQL 18.6 and DuckDB 1.5.6/2.0.0. PostgreSQL had 3,308 complete identity matches from
  5,666 observations; DuckDB had 38/44 from 2,941/3,168 observations. Remaining observations include
  rejected/unconstructible invocations, grammar gaps and missing parameter descriptors. No type
  mismatches remain in these runs; these numbers are not full semantic coverage. A preceding PG
  run exposed catalog-type identity versus SQL declaration defaults for BIT/CHARACTER; native
  Parse/Describe confirmed the mapper's qualified unmodified identities preserve typmod -1.
- Compared old and registered invocation planners over all 29,018 retained native function rows:
  generated query arrays are identical. Adapter contracts discover all retained contexts from
  the validated model rather than maintaining a second grammar/version case list.
- Comparator checkpoint CI `42386624346` produced review-only native audit failures. Reviewed all
  33 CI contexts against the generation corpus: inventories, recognition counts and retained
  grammar-gap behavior are unchanged. Only recognition evidence fingerprints changed. Replayed
  retained SQL Server engine descriptions after strict wire decoding; 20 spelling/ID differences
  were the documented NUMERIC/DECIMAL equivalence. No unapproved type differences remain.
  SQL Server profiles have 62–78 complete logical identity comparisons in this replay. The updated
  source still requires fresh current-head native CI; replay is not a substitute for that lane.
- Updated those reviewed fingerprints and the existing local SQLite context after checking
  unchanged inventories/counts/gaps. Actual native type disagreements remain non-baselinable.
- Registered audit adapters and reviewed comparator evidence pass local typecheck, audit-script
  typecheck, quality and all 54 repository contract files. Final focused adapter/comparator checks
  also pass after the category-probe contract was made explicit. Native CI for the next pushed
  head is still required; the failed older run is not recorded as a pass.

## Requirements still open

1. Complete independent native comparison for MySQL/SQLite, SQL Server live validation of the
   new comparison owner, modifier/identity regression witnesses across supported versions and
   retained qualification evidence. PostgreSQL/DuckDB/SQL Server expected-side host parsers have
   been removed; incomplete native descriptors remain explicit gaps.
2. Complete semantic facets for every IR category, immutable upstream source locks and
   field/projection-loss accounting. The structural v2 model and legacy importer are implemented;
   unknown historical provenance is not upgraded to qualified source evidence.
3. Pinned structured source extraction for every declared engine/version/profile.
4. Full signature/type/keyword/operator/cast/syntax generation, including special invocation
   forms, generic constraints, named/default/variadic arguments and table outputs.
5. Grammar-owned semantic rule migration and real runtime/inference mapping integration.
6. Independent category-specific live qualification, generated invocation classes, retained
   regression witnesses, explicit gaps and blocking required native lanes.
7. Extension contribution captures/qualification and third-party packed-consumer proof.
8. Explicit analysis entrypoints/preloading and documented breaking root API transition.
9. Offline deterministic build/typecheck bootstrap, disposable executable generated code and
   correct compiled npm/editor artifacts. The pure Node path and clean-room generation proof are
   implemented; deleting tracked outputs and qualifying the complete build/distribution remain open.
10. Coverage ledger migration, current missing-feature documentation and public qualified scope.
11. Full repository/native/packed/editor/performance verification, PR review resolution and
    final requirement-by-requirement completion audit.

This list preserves the full goal. It is not a reduced definition of ready-to-merge.
