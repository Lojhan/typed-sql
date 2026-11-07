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

The semantic-facet checkpoint adds statically inferred and runtime-validated semantic facets across
all nine inventory categories. Registered owners populate observed properties; unavailable facts
remain unknown, including MySQL HELP type identities, explicit casts from negative implicit-cast
observations, installation state and syntax productions. Case folding stays owner-controlled.
All 55 contract files pass after the initial integration; final focused/type/quality checks also pass after
the owner-controlled case-folding refinement. Runtime catalog outputs remain byte-identical.
PostgreSQL routine/type/cast emission now consumes validated model entities directly. DuckDB cast
emission consumes typed endpoints/contexts, and its type lookup uses typed canonical identities.
Required type/cast facts fail closed without falling back to native payloads. Legacy PostgreSQL
helper exports delegate to the same semantic projectors rather than maintaining a second mapping.
Grouping/projection contracts expose statically typed entities instead of implicit `any` arrays.
Other emitter projections still require migration; full projection-loss accounting remains open.
SQL Server type emission now consumes typed physical storage identity and dimensions, with
unknown width/identity rejected rather than coerced from missing raw fields. Alias relationships
remain explicit policy, independent of shared storage. Forged native payloads do not affect output.
Its runtime generated catalog remains byte-identical; focused projection tests and typecheck pass.
All generated runtime catalogs are byte-identical. All 56 contract files passed; final focused
checks cover required-fact removal and forged native payloads after grouping type annotations.

- Native lanes for SQL Server 14/15/16/17 and PostgreSQL 14/16/17/18 passed on
  checkpoint `048d22ed` in CI run `42388317055`; migration run `42388316819` passed.
  The full CI workflow is still running, so those results do not claim overall success.

- Capture provenance now binds complete normalized inventories/targets to declared tool-file byte
  hashes, producer entrypoint, dependency-lock digest and Node runtime. Corpus persistence and
  model normalization preserve the record; identified native extractors require their manifest.
  Existing captures retain unknown evidence. Pinned contexts reject missing or changed pins.
- All 57 contract files, typecheck and quality pass after initial integration, with final focused
  provenance/model checks also passing. A live SQLite capture imported into a model with four
  identified native sources and 65 recorded tool files; licensing remains unknown. Runtime
  catalog bytes are unchanged. This does not complete vendor locks, archive retention or the
  entire acquisition dependency closure.

Native acquisition now uses registered owners for queries, row transforms, scope, limitations and
derived inventories. Shared collection has no engine-name cases or closed grammar allowlist.
Provenance, review and diff helpers accept the same injected registry. An inherited graph test
exercises discovery through bound provenance, corpus import, normalized model and review.
All 27 built-in query strings are byte-identical to their previous definitions. Independent old/new
DuckDB 2.0 collections on fresh instances produced the same full capture hash
(`e7f87506b96d01f1f1bac4c139f89f5dc48c42a9378bbafd409bbab6e86185cb`).
Unexpected connection failures during derived probing now propagate; known unsupported native
types/driver descriptors remain unprobeable evidence. Typecheck, quality and all 58 contract files pass locally.


- Added SQLite vendor source locks for all five retained versions, with immutable Git/Fossil
  revisions, per-file byte digests and the pinned license notice. The source adapter compiles
  the vendor keyword table under explicit defines instead of regex-parsing C initializers.
  Each default source profile exposes 147 enabled keywords; later tables additionally retain
  disabled WITHIN. Current parser vocabulary contains 83 of those names; 64 are source-only
  and 18 parser words are absent from the enabled vendor list. These are lexical counts, not
  semantic support or reserved-word qualification.
- Generation validates normalized facts and extractor pins and produces the complete vocabulary
  comparison. Explicit refresh reuses old revision pins, verifies acquired bytes before compiling,
  and discovers versions from retained captures/declared endpoints. Ordinary build needs neither
  compiler nor network. Function source is locked but not yet extracted. Raw archive retention,
  native build-condition reconciliation and other vendor adapters remain open.
- All 59 contract files, typecheck and quality pass locally. Repeating the explicit SQLite
  source refresh succeeds with the retained revision pins; final offline generation passes.
- Pushed checkpoint `6ab73181` passed CI, migration integration and dev workspace integration.
  These results do not qualify the subsequent vendor-source changes or complete the full goal.

SQLite source registration checkpoint:

- Full source archives are byte-pinned for all five retained revisions. Fresh temporary builds
  generate the vendor amalgamation and read its registration hash, argument binder and native
  `function_list`. Independently pinned members must match the archive before executing build steps.
  The archive helper rejects links, special entries, duplicate/noncanonical paths and root escapes.
- Executable TypeBox schemas validate all keyword/function facts. Default and extended source
  profiles retain exact source IDs, requested defines, observed compile options, native limits,
  registration flags/encoding/kind, binder minima, internal/window metadata and visible connection
  registrations. The extended profile requests math, FTS5, RTREE, SOUNDEX, percentile and offset
  features; it is not an exhaustive set of possible native build configurations.
- The latest extended profile contains 180 global registrations and 157 distinct visible names.
  Every current function-policy name occurs in that profile. Nineteen visible names have no
  ordinary-function policy, including operator/keyword forms and extension helpers. These remain
  explicitly accounted for; name presence does not prove semantic support. Formal names, argument
  types, handler-specific constraints, return types and nullability are not fabricated.
- Source evidence exposed SQLite -3/-4 variadic registrations misclassified by the legacy mapper.
  The owner now handles the registered sentinels and rejects unknown/impossible arities. Shared
  signature identity consumes the owner's variadic fact, without interpreting SQLite arity codes.
- Migrated seven derived flags per affected context across six retained SQLite contexts and the
  standalone live fixture. All 33 contexts preserve exact native fields, order/counts, target
  identity and non-function inventories. The reference audit changes only fingerprints; every
  observation/status/count/limitation is identical. Detailed hashes and changes are retained in
  `variadic-signature-migration.json`. Native recognition/inference findings are unchanged.
- CI for keyword checkpoint `5fb2e603` exposed a Windows checkout issue: source files converted
  to CRLF changed the exact-byte extractor revision. Source adapters now explicitly use LF in
  `.gitattributes`; a contract protects that checkout requirement. Other source/native lanes were
  not implicated by that failure; final Windows CI must still qualify the fix.
- Vendor builds, final typecheck and quality pass. The full contract run passed 58 files and
  exposed a native Node `bigint` arity path rejected by the new strict guard. The owner now
  handles exact safe bigint wire values; targeted SQLite-matrix, mapper and source contracts all
  pass after the fix. Other contract files passed in the full run. A simulated Git checkout with
  `core.autocrlf=true` and `core.eol=crlf` retains exact bytes in all six source-adapter files.
  Runtime package catalogs are byte-identical; the work does not yet complete typed emitter/host
  migration or native qualification.

DuckDB typed-routine projection checkpoint:

- Production routine emission now consumes normalized routine entities, including ordered modes,
  explicit variadic evidence and validated property values. The legacy helper delegates to the
  same projector. Unknown native type facts remain null; unsupported rich type expressions,
  unavailable parameter evidence, unknown modes, malformed ordinals and conflicting macro
  policies fail closed rather than recovering data from raw payloads.
- Generated runtime catalog files remain byte-identical. All 6,180 shared routine entities across
  both retained DuckDB versions are checked against the previous raw-field projection. Poisoning
  or deleting the opaque payload cannot affect projection or accounting results.
- A generated per-routine projection report records formal-name/default/output/unknown facts
  that the existing public tuple cannot represent. Version 1.5.6 retains 546 named-only parameter
  entries and 5,360 known formal names; 2.0.0 retains 1,270 and 6,334. Default knowledge remains
  unknown for those entries. These counts are per captured overload, not distinct functions.
- Moved the existing metadata JSON formatter into the private neutral model workspace, preserving
  its output format and audit re-export. The per-record report stays readable without expanding
  every record over many lines. All 59 contract files, typecheck and quality pass locally.
- Current pushed checkpoint `5011e007` passed migration and dev-workspace integrations. Its
  Windows build/generation step now passes, qualifying the prior extractor-byte checkout fix;
  the complete editor/CI workflows were still running at inspection. Native/distribution jobs
  observed so far pass. These observations do not assert overall current-head CI success.

DuckDB generated-name runtime binding checkpoint:

- Generated parallel name indexes now feed the runtime binder. Names come from normalized formal
  input slots for every emitted overload; no per-function parameter-name lists are maintained.
  The public seven-field signature tuple remains compatible. The projection report now distinguishes
  consumed positional names from named-only/default/output/evidence facts still absent from runtime.
- Grammar-owned version policy preserves native distinctions: 1.5.6 scalar calls treat names as
  labels, macros bind formal slots, and its parser-level IF construct has an explicit exception;
  2.0.0 binds formal slots. Metadata does not establish these rules by itself. Independent native
  regression witnesses prove the distinction (reversed POWER arguments yield 8 versus 9).
- The resolver reuses core's grammar-neutral slot binder, folds names under DuckDB policy and
  reorders expression nodes before inference. Unknown/duplicate names, invalid ordering and
  ambiguous assignments fail closed when the engine version enforces slots. Parser nodes preserve
  quoted function-name evidence; source keyword roles distinguish unqualified invocation forms.
  Existing STRUCT/UNION constructor field semantics remain grammar-owned.
- Separate SDK processes verify both native versions, quoted NULLIF macro binding, scalar/macro
  name errors, variadic fixed slots, constructor fields, ordered parameter types, nullable result
  types and diagnostic source spans. Projection contracts compare all captured positional names
  against the generated facts. Remaining table options/defaults and full invocation-class auditing
  still require the broader qualification work; these witnesses do not claim universal parity.
- All 40 DuckDB test files pass with coverage thresholds (98.81% statements/lines, 97.78% functions,
  90.86% branches). All 59 repository contract files pass; final focused checks also pass after
  strengthening span/parameter assertions. Build, typecheck, quality and documentation build pass.
- The first performance run, concurrent with docs building, missed PostgreSQL semantic-metadata
  latency (p50 10.56 ms versus 10 ms). A repeat after docs completion passes unchanged default
  budgets and unchanged code. Both logs are retained under ignored checkpoint artifacts.
- Prior pushed `5011e007` completed full CI and both integration workflows successfully, including
  Windows/macOS editor SDK lanes and native/distribution checks. The typed projection checkpoint
  `907be40a` is pushed; current behavior changes still require their own fresh CI qualification.

DuckDB source-signature extraction checkpoint:

- The expanded, still-uncommitted invocation audit reports zero binding failures for 1.5.6
  across 19,279 distinct SQL statements. Its 2.0.0 run reports 427 named-control failures;
  these remain unresolved and must not be represented as qualified coverage.
- Vendor `FunctionParameter::GetKind()` distinguishes positional-only, standard, variadic
  positional, keyword-only and variadic keyword parameters. `duckdb_functions()` omits this
  information and combines positional table parameters with typed options. Parameter spelling
  therefore cannot establish that an argument accepts a name. The previous name-only runtime
  integration is incomplete, including overload selection when modes differ by overload.
- A registered DuckDB acquisition owner now compiles a small catalog reader against headers
  from immutable source revision `d54cbbe3df17e8e5ce68312f483b4155836112aa`, linking the locked
  official 2.0.0 shared library. It verifies the library source ID, scans native registrations
  and checks their count against the native SQL catalog. Retained facts contain all 3,235
  registrations, parameter modes/types/default SQL, separate typed options and aliases,
  macro bodies and macro-default expressions. Unknown macro types remain null.
- The current retained extraction profile is darwin-arm64, without additionally loaded
  extensions. It has 60 registrations with typed options, 23 with parameter defaults and four
  with macro defaults. These counts describe registration metadata, not function semantics,
  all-platform equivalence, extension coverage or native result/nullability qualification.
- Source/archive/license/library bytes and extractor inputs are hashed. Source acquisition is
  explicit (`pnpm catalog:source duckdb`); ordinary tests validate the retained JSON offline.
  The extractor rejects truncated output, duplicate identities, unknown parameter kinds,
  noncontiguous overloads and library/source identity mismatches. Test fixtures cover the
  positional-only MOD and mixed-mode AVG overloads and the RANGE table-option boundary.
- Still required: consume these source facts through the normalized model and generated runtime
  binder, qualify overload selection with the full 2.0.0 audit, add the 1.5 source adapter,
  and retain extension/platform comparisons. The existing generated-shape regression suite
  also exposes a 1.5 constant-NULL table-result mismatch that remains open.
- Last pushed `17d65575` failed source-quality CI on two contract test timeouts; both integration
  workflows passed. A local projection-test optimization and the broader audit/runtime fixes
  remain uncommitted and require fresh full verification. The PR remains a draft.

Generated invocation and vendor-mode binding checkpoint:

- The neutral routine model now represents parameter passing separately from input/output mode.
  Older captures have explicit unknown passing facts; DuckDB source registrations normalize all
  five vendor modes through the same validated routine contract. Macro defaults and typed-option
  metadata are preserved. Binding projection requires known passing modes/default availability.
- DuckDB generation consumes locked source facts offline and joins overloads by normalized
  namespace/kind/input/result/variadic types. The 2.0 policy requires vendor mode evidence and
  rejects a missing source profile. Generated eligibility feeds slot assignment and restricts
  subsequent type matching to the same eligible overloads. Core supports named-only input slots.
  Existing seven-field public tuples remain compatible. Each generated binding row uses a
  TypeScript `satisfies` check followed by widening to avoid an unrepresentable inferred union;
  this has no runtime helper calls and does not disable validation.
- Full local generated binding runs now have zero failures: 2.0.0 covers 3,235 registrations and
  20,587 distinct statements; 1.5.6 covers 2,945 registrations and 19,279 statements; Node 24.22.2
  SQLite 3.53.4 covers 196 registrations and 413 statements. Reports retain accepted controls,
  rejected cases, source records, normalized signatures, unqualified host results and explicit
  metadata/rendering gaps. Console output includes qualification and entities with gaps.
  These runs are incomplete qualification, not 100% semantic parity or distinct-function counts.
- The 427 prior 2.0 named-control failures are resolved. More native-valid calls now remain
  unknown because an ineligible overload can no longer provide an optimistic type. A native AVG
  witness demonstrates that an eligible DECIMAL catalog overload can bind to a DOUBLE result;
  the host leaves that dynamic result unknown. The native signature is not treated as a proof
  of bind-callback semantics.
- Current source binding projection still reports 206 unmatched table/pragma shapes and eight
  scalar keyword-rest slots unsupported by the host binder. Source records retain all their
  facts. The legacy table inventory's positional/option boundary and unavailable return schema
  cannot be silently repaired from parameter spelling. Named-only/default/keyword-rest/table
  output migration and independent semantic qualification remain required.
- DuckDB 1.5 folds constant NULL table arguments to untyped SQLNULL before overload selection
  (vendor bind_table_function.cpp); the host lacks its overload-cost evidence. Such bindings now
  diagnose instead of claiming a timestamp type. The regression corpus retains these witnesses
  and separately verifies concrete BIGINT/TIMESTAMP/TIMESTAMPTZ table results in both versions.
- Parser quoting, duplicate constructor names, ambiguous NULL overloads, unresolved MAP returns,
  range arity/types and native alias/name-based literal constraints have regression witnesses.
  The grammar-neutral shape planner derives cases from discovered metadata rather than a
  maintained function list; the embedded CI matrix requires its live runs and retains reports.
- Local checks pass: 61 contract files, 42 DuckDB files with coverage thresholds, 22 core files
  with coverage thresholds, repository typecheck/quality/build/documentation and unchanged performance budgets.
  Projection tests normalize the
  corpus once rather than four times and avoid cloning the full entity table per negative check.
- Pushed source-only `760e493a` failed CI because its normalizer source digest changed while the
  generated manifest was not included; both integration workflows passed. This checkpoint
  refreshes the generated schema, runtime modules, reports and manifest together. Fresh exact-head
  CI remains required, including packed-consumer timeout qualification. The PR remains a draft.

Registered native connection and nullable-schema checkpoint:

- The shared audit CLI no longer selects drivers, connection metadata, reference version bands
  or embedded capture targets by grammar ID. Registered connection owners provide native
  sessions and optional inventory completion; analysis owners provide reference bands. Native
  SDK captures run in separate processes through registered target lists. Driver dependencies
  remain outside grammar runtime packages.
- Connection inheritance supports a graph contribution without changing shared orchestration.
  Bound query/prepare/close methods preserve adapter receivers; missing engine versions close
  the connection and fail. Inventory completion runs before provenance and cannot change the
  captured engine identity. SQLite's existing compile-option augmentation belongs to its
  connection owner; other SQLite matrix capture scopes remain unchanged.
- Native rejection details are retained separately from stable protocol codes. Shape auditing
  combines them for owner classification, while legacy recognition keeps stable codes.
  PostgreSQL bare SQLSTATE and SQL Server bare native error codes now classify correctly.
  Connection/probe contracts exercise inheritance, driver-message evidence and identity guards.
  Neutrality contracts now include the CLI and connection registry.
- A retained Linux capture exposed parameterized RANGE/GENERATE_SERIES claims that still relied
  on unqualified 1.5 prepare metadata. Actual execution proves the same casted query returns
  BIGINT for NULL bindings and TIMESTAMP/TIMESTAMPTZ for non-NULL bindings on 1.5.6; 2.0.0 keeps
  declared timestamp schemas. Both versions have NULL/non-NULL execution regression witnesses.
  The 1.5 resolver diagnoses nullable bindings when alternative native output shapes remain
  possible without overload-cost evidence. One-argument BIGINT bindings remain inferable.
- Four reviewed recognition contexts are updated in `connection-recognition-review.json`.
  All nine native inventory summaries, native prepare fields and parameter tuples are unchanged.
  Darwin comparison-record migrations account for prior independent-oracle changes. Six 1.5
  output claims become explicit diagnostics, including conservative BIGINT cases whose native
  overload costs are not yet generated. No new native type confidence is inferred from a replay.
  Linux reanalysis uses only retained actual queries/descriptors from CI run 42402470237,
  artifact 13586406017, rejects any new native query, and only permits formerly unverified
  descriptions to become unknown. Fresh exact-head Linux CI remains required.
- `e44023d7` completed 41 CI jobs successfully, including source-quality/full verify and packed
  consumers. Seven jobs were skipped. Its only substantive failed job was the DuckDB 1.5 live
  recognition-baseline review; the aggregate quality gate consequently failed. Both integration
  workflows passed. This verifies the projection-test timeout fix on CI without raising limits.
- Current local checks pass: 62 contract files after build completion, 42 DuckDB files with
  coverage thresholds, typecheck, quality, build, docs build and unchanged performance budgets.
  Fresh Darwin 1.5 and SQLite live captures match the reviewed baselines. The PR stays draft;
  the full remaining requirements below are unchanged.

Metadata-derived spelling qualification checkpoint:

- Commit `458d917b` passed full CI run 42405990382 and both integration workflows.
  This qualifies the previous connection/nullable-schema checkpoint on the actual Linux lanes.
- Function invocation controls now acquire uppercase/lowercase and Unicode collision probes
  derived from the running JavaScript Unicode casing tables. No function or collision-character
  allowlist is maintained. Every control receives its own spelling probes, including named-only
  and variadic controls; native acceptance decides whether the spelling is supported.
- Native DuckDB rejects Kelvin-sign routine spellings, dotless-i type spellings, long-s keywords
  and Unicode lookalikes of current-time expressions that the host previously accepted.
  Grammar-owned ASCII normalization fixes those paths. Both supported versions retain native
  regression witnesses. Expanded binding audits pass with 35,465 distinct statements on 2.0.0
  and 32,991 on 1.5.6; qualification remains incomplete because unresolved controls and semantic
  facets are explicit gaps.
- The expanded SQLite audit found 111 native-rejected/host-typed spellings. ASCII function,
  keyword and type normalization removes those failures: the local Node 24 inventory produces
  738 distinct statements across 196 entities with zero binding failures. Native regression tests
  also preserve nullable primary keys whose declared type only resembles INTEGER, and distinguish
  ASCII `k` from Kelvin-sign columns in STRICT tables. Flexible affinity remains conservative.
- The neutral schema index accepts caller-owned folding and isolates cache entries by policy
  identity. SQLite supplies its ASCII policy. Existing callers retain the historical default;
  this is not evidence that PostgreSQL/MySQL identifier semantics have been fully migrated.
- Core (23 files), SQLite (16) and DuckDB (42) package tests pass with their coverage
  thresholds. All 62 contract files, typecheck, quality, build and unchanged performance
  budgets, documentation build and the full workspace `pnpm test` pass locally, including
  native TypeScript watch/SQL-file, language-server, editor, synthetic-grammar and packed
  consumer checks. New-head CI is still required before promotion. Function spelling probes
  do not yet constitute automated keyword/type/operator/identifier qualification across engines.

Registered documentation-reference checkpoint:

- Reference version targets, native-capture file lists, upstream URL/markup rules, minimum function
  counts and reference scope now belong to registered source owners. The shared refresh/load
  runner contains no grammar implementation imports or engine-ID dispatch. Signature decoration
  continues through an injectable mapper registry. Composition order preserves existing reports.
- Contributions inherit source contracts, supply their own mapper, refresh into namespaced files
  and load their captures through the same runner. Registry construction snapshots version lists
  and rejects invalid paths, duplicate/overlapping versions, cycles, absent collectors and invalid
  policies. Collection rejects category replacement and propagates upstream failures.
- The original and registered collectors produce byte-identical JSON for all 14 documentation
  targets against synthetic upstream pages. `reference-owner-review.json` retains their digests;
  a contract replays every registered documentation target against those fixtures. This is
  refactor evidence, not a new upstream acquisition or native qualification claim. Existing
  reference/capture files and generated catalogs are unchanged.
- Focused source contracts exercise inherited graph collection, mapping, download reuse, hashes,
  persisted/loadable records, lost inventories and HTTP/redirect rejection. The remaining full
  source extraction and semantic requirements below remain open. All 63 contract files,
  repository typechecking and quality checks pass locally; generated artifacts remain unchanged.
- Prior checkpoint `03025aaa` passed full CI run 42408681922 and both integration workflows.
  New reference-owner commit CI remains required.

Pinned PostgreSQL bootstrap-source checkpoint:

- Registered `catalog:source postgres` discovers all catalog data files from the immutable source
  archives for the six exact retained versions (14.24, 15.19, 16.15, 17.11, 18.6, 19beta3).
  Full archive/member/license bytes and extractor sources are locked. The pinned vendor
  `Catalog.pm` expands header defaults and generated array-type rows; raw schema/row fields and
  source locations are preserved. Explicit acquisition uses Python/Perl; normal generation uses
  committed facts and Node only. An offline cached refresh with fetch disabled reproduces both
  the lock and fact files byte-for-byte.
- The shared source store contains 7,423 distinct catalog rows and 80 schemas, referenced by exact
  version/location. Versions 14-18 expose 24 bootstrap data catalogs and 19beta3 exposes 25.
  Procedure registration counts are 3,186 / 3,228 / 3,281 / 3,314 / 3,397 / 3,421 respectively.
  This is source inventory coverage, not executable routine mapping or semantic qualification.
- PostgreSQL generation validates the complete fact closure, extractor revision and source locks.
  Source/native keyword names and categories agree exactly on all six contexts (457 / 460 / 471 /
  491 / 494 / 511). A disagreement blocks generation. The generated
  `postgres-source-coverage.json` accounts for all native keywords separately from parser words
  and reports procedure/type name differences without upgrading them to overload parity.
- Each native capture contains five additional procedure names: Snowball and PL/pgSQL handlers.
  Native-only composite/system type names remain explicit. SQL installation scripts, parser
  productions, configuration/platform rules, installed extension profiles and full semantic
  projection remain unfinished; pinned archives retain inputs beyond the interpreted catalogs.
  No existing runtime signatures or type policies are changed by this checkpoint.
- New contracts cover exact target membership, raw variadic/strictness facts, native keyword
  disagreement, unknown declaration formats, digest/version/closure corruption and orphaned
  data. All 64 contract files pass, including clean-room generation and packed consumers.
  Repository typecheck, quality and network-disabled cached source replay pass.
- Prior reference-owner checkpoint `da17b810` passed full CI run 42409489345 and both integration
  workflows. The source checkpoint requires its own exact-head CI before promotion.

PostgreSQL source-routine projection checkpoint:

- Bootstrap source descriptors initially disagreed with native captures on 41-84 routines per
  version. Independent comparison exposed installation-SQL name/default overlays, unquoted array
  whitespace rules and PostgreSQL 19 bootstrap constant-array default expansion. These are now
  interpreted from pinned inputs; no per-function exception list is introduced.
- Source facts retain content-addressed installation SQL, grammar/bootstrap inputs and the full
  upstream license notice. Every interpreted text blob is checked against the locked archive
  member's raw byte digest/length. Explicit refresh can add selected members from an unchanged
  pinned archive but rejects any changed or removed existing member pin.
- A bounded SQL-header lexer retains unsupported header forms as gaps, with strings/comments
  excluded from declaration discovery. Unconditional SQL type aliases are extracted from
  grammar actions; conditional actions remain unqualified. Source/default-expression evidence
  stays distinct from native canonical rendering and runtime semantics.
- All 19,827 bootstrap routine descriptors across six native contexts agree on parameter vectors,
  names/modes/default counts, result/set behavior, variadic metadata, strictness, volatility and
  parallel flags. Type spellings are bridged through captured native type catalogs, not a host
  parser. Canonical default rendering, result nullability, execution and decoding remain
  unqualified. Five SQL-installed handlers per context remain explicit native-only source gaps.
- PostgreSQL native-signature emission now consumes validated source routine models where that
  comparison succeeds. Cross-profile disagreement, unsupported installation headers or source/native
  descriptor drift fail generation. Native-only handlers retain native metadata and their source
  gap is reported. The generated runtime catalog bytes are unchanged.
- New contracts compare every projected runtime signature with native-derived metadata across all
  six versions, preserve unknown nullability/decoding policy, reject descriptor corruption and
  source/member text mismatches, and exercise SQL/array/grammar parsing boundaries. Focused tests
  and typecheck pass. All 65 contract files pass, including clean-room generation, packed
  consumers and the full source-routine comparisons. Quality and network-disabled cached source
  replay pass. Exact-head CI remains required.
- Prior checkpoint `64ad63ca` passed full CI run 42410652224. Remaining full-goal requirements
  below are unchanged; this is not complete grammar/source/semantic parity.

PostgreSQL installed-routine closure checkpoint:

- Source extraction additionally locks Snowball/PL/pgSQL installation SQL and extension control
  files from the existing immutable archives. Namespace comes from explicit search-path/control
  declarations, not native identity copying or a maintained routine list. A bounded external
  declaration reader interprets result types, parameter metadata and declared/default SQL
  strictness/volatility/parallel attributes. Unsupported clauses remain gaps and block projection.
- All 19,857 version-specific native routine descriptors now match source records across the six
  retained contexts, including the 30 previously native-only handler descriptors. The source
  projection has no native-only signature fallback; an unmatched native routine blocks generation.
  Source coverage separates bootstrap row/name counts from the complete routine descriptor census.
- Every projected runtime signature still matches native-derived metadata and generated runtime
  catalog bytes remain unchanged. Tests also reject missing/extra descriptors, unknown installation
  attributes, conflicting/missing namespaces and duplicate clauses. Nullability, execution,
  canonical default rendering and decoding retain their previous unqualified scope.
- All 65 contract files, clean-room generation, packed consumers, repository typecheck, quality
  and network-disabled cached-source replay pass locally. Prior checkpoint `34c4c2bd` passed
  full CI run 42412683471; new-head CI remains required. The full remaining requirements below
  stay open.

MySQL locked registration-source and deadline checkpoint:

- Registered `catalog:source mysql` pins full official source archives, selected factory/lexer/YACC
  inputs, license notices and extractor bytes for all three retained versions (8.4.11, 9.7.2,
  26.7.0). Cached refresh reproduces source facts and locks byte-for-byte with fetch disabled.
  Normal generation consumes committed facts through Node only.
- Factory inventories retain 347 / 353 / 353 registrations. Standard macro interpretation supplies
  291 / 297 / 297 partial arity bounds, odd/even constraints and internal-call flags. Every version
  retains 56 specialized factories with unknown arity and two debug-conditional registrations;
  preprocessor branches remain explicit, not assumed enabled. Lexer-classified function names
  (35 / 36 / 36) and all symbols are separate inventories, not conflated with ordinary factories.
- Keyword classification follows the pinned vendor keyword generator's lexer/YACC rule. All
  734 / 760 / 763 names/reserved flags agree exactly across seven retained native contexts.
  MySQL generation now rejects disagreement and emits complete source/gap accounting. Formal
  parameter types/names, defaults, return types, conditional availability, special invocation
  syntax, nullability and decoding remain unqualified; runtime policy mappings are unchanged.
- Exact-head CI for `ae86866a` failed source-quality in DuckDB's stream-health deadline regression;
  the aggregate gate failed consequently. An early timer could request cancellation before the
  declared wall-clock deadline, allowing an adapter's subsequent clock check to see active controls.
  Core now rechecks the clock on each timer callback. A deterministic fake-clock witness proves
  one early cancellation before the fix and zero after; cancellation still occurs once at expiry.
  Core and DuckDB focused regressions pass. This changes runtime behavior and includes a Changeset.
- Full workspace `pnpm test` passes, including all 66 contract files, source/clean-room generation,
  coverage gates, editor and packed consumers. Typecheck, quality and build pass locally.
  Documentation build passes. The performance gate reached its final report after all budget
  assertions passed. New-head CI remains required before promotion.

MySQL literal instantiator bounds checkpoint:

- Specialized factory interpretation follows unconditional public literal `Min_argcount` and
  `Max_argcount` declarations through source alias chains. Each inferred range retains symbol/line
  evidence. It rejects private, conditional, dependent and specialized class interpretations;
  aliases that select template parameters and cyclic aliases cannot silently acquire global bounds.
- All three retained versions resolve 50 additional registration bounds each. Six factories per
  version still require template-specialization interpretation and retain unknown arity. This
  changes source audit facts only, not runtime function policy or semantic qualification.
- All 66 contract files, repository typecheck and quality pass locally. Cached source replay
  reproduces facts/locks byte-for-byte with network disabled. Full requirements below remain open.

DuckDB retained-version source checkpoint:

- Source refresh discovers both retained exact versions and selects their source API within the
  DuckDB owner. The legacy official universal library uses a flat zip; extraction rejects duplicate,
  noncanonical, encrypted, directory and nonregular members before writing into the fresh workspace.
- DuckDB 1.5.6 locks revision `069cc9f9b5be802405797faecc284961b07c70ef` and records 2,945
  inventory entries. The ordinary catalog supplies 2,930; the separate vendor window-name registry
  supplies 15 additional entries. Their unavailable signatures stay unknown. Legacy positional types,
  varargs, named option maps and macro declarations are retained without inventing formal names or
  parameter-passing descriptors. Those facts do not replace the existing version binding policy.
- DuckDB 2.0 facts reproduce unchanged apart from the explicit signature-API label. Generated runtime
  package files remain byte-identical. Both-version refresh and cached network-disabled replay pass;
  focused tests and all 66 contract files pass. Repository typecheck and quality pass. Nine flat-zip
  extraction cases cover valid members, traversal/Windows path escapes, duplicates, links and special
  files. Full requirements below remain open.

SQL Server parser-source checkpoint:

- Registered source acquisition discovers compatibility levels from retained native captures rather
  than equating server major versions with parser profiles. ScriptDOM compatibility levels 140,
  150, 160 and 170 cover all ten retained engine/settings contexts. These are public parser-source
  profiles, not engine source releases or a builtin semantic catalog.
- Full immutable official archives, selected grammar/common-token members, the MIT notice and
  extractor bytes are locked. Facts retain complete source text, UTF-16 offsets, token declarations,
  all parser/lexer production spans and opaque C# action/exception bodies. The four inventories
  contain 1,577 / 1,615 / 1,648 / 1,681 productions. Unsupported top-level declaration forms fail
  extraction. Generation rejects stale native-context associations and reports unqualified host
  production coverage and engine semantics. Runtime package outputs remain unchanged.
- Focused contracts, typecheck and cached replay with fetch disabled pass. The local performance
  gate passes without a budget change. All 67 contract files and repository quality pass locally. CI for prior
  head `f051df8b` passed tests but failed editor schema-churn p99 at 131.81 ms against the 120 ms
  GitHub Actions budget. Failed-job retry attempt 2 is running; the overrun is not waived.
- Signature/type rule sourcing, semantic action interpretation, builtin generation and independent
  native qualification remain open together with all full requirements below.

Recognition fallback ownership and MySQL semantic findings:

- Shared live enrichment now obtains fallback reference bands from the registered mapper and
  accepts contributed reference/recognition registries. The remaining MySQL-ID version-width
  branch is removed. Builtin reference rows are preserved; inherited `vendor/graph` fallback and
  retained native inventories are exercised without engine dispatch.
- MySQL source inspection exposes existing coarse numeric-policy problems: `ABS` inherits the
  numeric hybrid rule, while the manual catalog assigns it the shared DOUBLE rule. `Item_dec_func`
  marks its results nullable, whereas the current shared numeric family only propagates argument
  nullability. These require source-backed family migration and independent native regression
  witnesses; they are not claimed fixed by source acquisition. Local MySQL/container services are
  unavailable, but required native CI lanes remain available for qualification.
- Focused reference contracts, all 67 contract files, repository typecheck and quality pass.

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
