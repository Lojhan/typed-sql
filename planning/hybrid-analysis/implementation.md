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

## PostgreSQL native vertical and distribution proof

- Added explicit `postgres/profile` and `postgres/tag` entrypoints without full analyzer/catalog
  imports. Existing root/query analyzer compatibility remains; this is one grammar's additive
  profile boundary, not the completed breaking root-entrypoint migration.
- Added `postgres/pg-contracts` as a separate explicit native producer. Its declared PostgreSQL 18
  expression-query scope rejects unqualified binding/input contexts. The producer uses unnamed
  Parse/Describe, complete row modifiers where available, OID parameter metadata and conservative
  representation/nullability facts; it executes no candidate statement and grows no pg named cache.
- The dedicated read-only session pins semantic settings, hashes catalog/context metadata inside
  the server with SHA-256, and rejects WAL advances across acquisition. This is deliberately
  conservative: unrelated writes can reject generation. Relations/views/extensions, custom input
  coercions, native array shape and other majors remain outside this adapter's qualified scope.
- Real PostgreSQL 18.3 / pg 8.23.1 proof acquires an otherwise unknown user-function invocation,
  preserves bigint parameter/result descriptors, exports/reloads contracts, compiles real runtime
  plans and executes/decodes them. A counter verifies no execution during description. Injected DDL
  rejects acquisition. Native clients are closed before disconnected compilation.
- The actual native closure also recompiles identically in a fresh process outside the workspace,
  with copied distribution-only packages, no installed driver, full analyzer/parser/catalog files
  physically removed and JavaScript network traps. Deleting a required object fails loading.
  This is not an OS network sandbox or the final whole-project frozen TypeScript/CLI host gate.
- Packed tarball consumers separately exercise the same profile/contract/decoding path after heavy
  files are removed. PostgreSQL package coverage and package graph/documentation/API checks pass;
  the native proof is integrated into the existing PostgreSQL E2E lifecycle.
- The [native proof notes](./postgres-native-proof.md) record limitations and the reproducible
  [profile bundle measurement](./postgres-profile-measurements.json). No global catalogs are
  reachable in the measured tag/profile/frozen-host entries; old analyzer packages remain shipped.

## Independent reconciliation checkpoint

- Added normalized static claims, pure grammar-owned comparison contributions and qualified
  proof records. SQL/context/grammar/owner identities, ordered result/parameter shape and result
  kind are checked independently, including analysis that reported no error.
- Known disagreements return conflict with no qualified artifact. Missing required native facets
  or unverified known claims return incomplete. Upper-bound, exact and unknown nullability are
  distinct; conservative widening does not certify the original refinement.
- Successful proofs bind native evidence/source contracts, static claim hashes and the configured
  policy/owner revision. Consumers can require the independently configured policy hash and reject
  raw native or stale proofs. Proof loading validates its complete per-field comparison closure.
- Added a PostgreSQL pure comparison owner and tightened native acquisition to qualified built-in
  base representations. Custom snapshot type mappings do not count as independent native facts;
  the acquisition interpreter revision changes to v2.
- Real PostgreSQL proof now reconciles the acquired contract, injects a wrong successful offline
  type and rejects it, exports only the qualified contract, and enforces the configured policy
  in both disconnected and isolated consumers. These are one-query proofs, not project-wide mode
  orchestration or qualification of every supported grammar.
- The current publisher uses the conservative native plan. Retaining qualified static non-null,
  JSON and other refinements remains required, as do custom codec bindings and parameter authority
  from explicit SQL/static constraints when a transport has no meaningful native bind metadata.

## Live scheduling checkpoint

- Added an explicitly constructed native acquisition/reconciliation producer and a project scheduler.
  Identical requests share work; document versions and input/context/policy generations fence results.
  Immutable views invalidate synchronously, with coalesced notifications for synchronous consumers.
- Added bounded debounce/queue/record/subscriber limits, per-context/global concurrency, deadlines,
  transport retry backoff with jitter, explicit retry and shutdown draining. An adapter that ignores
  abort keeps its lease until it settles. Known rejection/partial/conflict/staleness clears old support;
  a matching last-good contract can survive a transport outage without claiming fresh verification.
- Deterministic clock/deferred-adapter tests cover rapid edits, shared cancellation, obsolete late
  results, queue eviction/recovery, noncooperative deadlines, backoff limits, malformed producer
  output, callback reentrancy/errors, active conflicts and synchronous context invalidation.
- The real PostgreSQL proof also runs acquisition/reconciliation through the scheduler, observes an
  immutable usable view without executing the candidate function, and invalidates it on a context
  generation change. This does not qualify additional PostgreSQL statement classes or other engines.
- Local validation passes analysis coverage (100% lines/statements, 98.71% functions, 95.27%
  branches), full typechecking, quality checks, public API/documentation contracts and package-graph/
  packed-consumer checks. Native proof uses PostgreSQL 18.3 and pg 8.23.1. Exact-head CI remains
  independent evidence; this checkpoint does not establish the final all-engine acceptance gates.
- This is a programmatic in-memory scheduling layer. CLI/editor integration, independent context
  freshness polling, disk cache/restart reuse and cross-process ownership remain required.

## Disposable query-cache checkpoint

- Added explicitly opened owned/versioned storage with workspace/config lookup namespaces,
  content-addressed context/query objects and atomic index publication. Successful cached outcomes
  are revalidated against exact request SQL/context/static claim/qualification/adapter/layout.
  Only digests, descriptors, sanitized statuses and local timestamps persist; no SQL/source claims,
  credentials or native error messages. Hits explicitly report remote freshness as unverified.
- Publication tokens bind cache instance, namespace epoch and per-request revision. Unrelated
  writers merge; competing replacements and producers predating invalidation are fenced. A known
  stale context retires the namespace. Negative results cannot preserve disproved evidence merely
  because storage is over budget. Transport failures do not replace persistent evidence.
- Cooperative cross-process locking uses the existing pinned filesystem lock library, loaded only
  when opening the cache. Short storage operations stay inside the lock; acquisition remains outside.
  Stale lock recovery and lease checks accompany generation checks. Private/cooperative local
  filesystem behavior is assumed; this is not an authentication boundary against malicious writers.
- A validated reservation ledger admits bytes before writing objects/indexes. Interrupted writers
  can overcount space until maintenance reconstructs usage. Per-publication admission avoids a
  full object-directory/stat scan; the namespace index remains bounded.
- Bounded regular-file IO rejects symlinks/invalid UTF-8, invalid ownership/schema/digests, oversized
  objects and corrupt/missing referenced closures. Pruning protects every namespace's references,
  handles abandoned staged objects, preserves foreign files and never operates on durable directories.
- Tests use real child processes for restart, first initialization, competing same-request writers,
  unrelated publications and prune races; also exercise corruption, resource pressure, invalidation,
  stale locks, namespace isolation, interrupted object publication and symlink escapes.
- The PostgreSQL proof persists and reopens a live qualified result, then retires it after known
  context change and rejects the old producer token. The disconnected durable proof remains separate.
- Local checks pass full typechecking, quality, documentation/API/package-graph and packed-consumer
  checks, plus the real PostgreSQL proof. Analysis coverage is 99.92% lines/statements, 98.97%
  functions and 94.38% branches. This does not establish exact-head CI or final all-engine gates.
- This stores concrete query outcomes only. Host cache/scheduler coordination, context observations,
  request-driven freshness, project catalog/declaration storage, cache status/maintenance CLI and
  actual editor/CLI offline/live workflows remain required.

## Independent candidate extraction checkpoint

- Added core `DialectProfile` and independent profile validation; eager `DialectPlugin` extends it
  with synchronous analysis. The
  contract consumer and PostgreSQL lightweight profile use the shared type without loading semantics.
- Added transient source and SQL-file candidate collectors. They share preparation with ordinary
  compilation, preserve exact SQL/source offsets and ordered physical/logical bindings, enumerate
  finite conditional variants and composed queries, and never call an analyzer. SQL-file factories
  and acquisition share the same named/repeated binding normalization.
- Fixed source metadata after structural and tuple expansion: full-statement physical positions
  and nested expression spans now follow the rendered SQL, including multi-digit renumbering.
  Fragment-local metadata remains local for existing fragment artifacts. Running SQL lengths avoid
  repeated prefix summation when recording the new positions.
- Scanner collection bounds static, dynamic and composition discovery instead of constructing an
  unbounded site list before applying limits. Unrenderable imported/chained composition bases stay
  visible to qualification even when ordinary compilation has no new rendering to analyze.
- Native qualification cannot correlate repeated calls/property conditions merely because their text matches;
  unstable repeated conditions require an explicit captured identifier instead of certifying a
  partial set of possible renderings. General per-occurrence coverage or qualified invariance
  for these expressions remains part of the structural-variant work.
- Explicit unrendered structural expressions are diagnostic rather than native bind values.
  Runtime-sized lists are not certified from a representative rendering; excessive/dynamic or
  ambiguous inputs remain visible. A collection's completeness is source-preparation status,
  not SQL/TypeScript/native/project-wide certification.
- The PostgreSQL native proof obtains its candidate through the compiler collector despite the
  offline resolver's unknown routine. The distribution-only frozen proof also collects it with
  full PostgreSQL analyzer/catalog/native modules physically absent and network APIs trapped.
- Local core/compiler/analysis suites and full typechecking pass. Compiler coverage is 96.81%
  lines/statements, 99.57% functions and 90.92% branches. Quality, documentation/API/package-graph,
  packed consumers, the real PostgreSQL proof and the existing performance gate pass. Exact-head
  CI and the final all-engine/new-workload acceptance audit remain separate.
- This removes the resolved-manifest dependency for source candidate input. Explicit mode/config
  descriptors, source-graph orchestration, qualification over all variants, CLI/editor integration
  and the remaining facet/parameter authority model are still required.

## Frozen configuration and CLI checkpoint

- Added real profile registrations with an optional explicit lazy analyzer loader. Config discovery
  returns raw registrations without initializing semantic owners; explicit owner resolution coalesces
  requests, preserves profile rendering/policy, binds owner methods and tracks lazy-imported source
  dependencies. Legacy hosts reject analysis configurations before initializing an analyzer.
- Added data-only analysis configuration and durable frozen views. Installed/configured interpreter
  identities are checked independently of recorded artifacts, alongside grammar, schema, decoding
  policy and qualification policy. Frozen views load only the declared durable closure.
- `check --frozen` and `analysis.mode: "frozen"` select the actual CLI path. It collects candidates
  before checking, rejects unavailable structural coverage, supplies the synchronous contract view
  to TypeScript and fences source/config/schema/project/closure changes during checking. Analyzer
  factories, schema providers and disposable cache files remain unused.
- Native TypeScript checking now discovers SQL assets and supplies their generated factory
  declarations through the in-memory filesystem. Invalid parameter types are rejected at the
  consumer; conflicting physical declarations fail rather than override evidence. SQL asset source
  analysis obeys configured source/declaration limits and reports unsupported SQL conservatively.
- PostgreSQL exposes pure contract compatibility identities without importing its analyzer or native
  client. The real PostgreSQL 18.3 proof consumes its qualified native closure through the high-level
  frozen loader after clients close, and in the distribution-only isolated process with heavy
  analyzer/native files removed. The CLI proof additionally checks the real native closure with
  analyzer/provider factories that throw if called. This does not yet prove the CLI itself runs in
  that physically stripped installation.
- Local checks pass core/config/analysis/compiler/CLI/PostgreSQL suites, full typechecking,
  quality, public API/package graph/documentation checks, packed consumers and the performance
  gate. Compiler coverage is 96.85% lines, 99.57% functions and 91.08% branches; config coverage is
  100% lines/functions and 96.62% branches. Exact-head CI remains separate evidence.
- Frozen CLI is the implemented product mode at this checkpoint. Offline/live orchestration,
  generation/watch/editor integration, project-wide resource admission, all-engine qualification,
  and final physically stripped native CLI proofs remain required. Bulk catalogs still ship.

## Offline host and persistent producer checkpoint

- Added exact recorded-context cache lookup without an analyzer claim. Target/adapter, SQL,
  parameter occurrences, context, codec/interpreter and qualification identities remain mandatory.
  Live qualification and recorded lookup share contract compatibility validation.
- Cache publication now fences the exact recorded candidate across competing static claims.
  Discovering a changed static claim retires the old proof to a partial result and rotates the
  epoch before returning a producer token. An outage cannot restore that superseded proof.
  A stale-context tombstone blocks every query in that recorded context, including durable hits
  in an offline host; fresh qualified acquisition can restore the context without resurrecting
  its old entries. Known negatives remain conservative under storage admission pressure.
- Added an explicitly persistent live producer. It always acquires fresh independent evidence
  for explicit live work, publishes through fenced cache tokens, preserves matching recorded
  evidence on transport outages, and refuses superseded publication or cancelled results.
  The scheduler uses this producer in the real PostgreSQL proof; product live hosts remain open.
- Added bounded offline contract-view preparation and actual `check --offline` selection.
  Durable/cache hits keep the analyzer unloaded. Hybrid misses lazily resolve the configured
  owner, retaining its runtime-type hook and analysis context; native-required misses cannot
  acquire authority from an ordinary offline result. Known cached rejection/conflict/staleness
  blocks optimistic fallback and reports a sanitized reason. Unexpected SQL outside the prepared
  set and changed schema/policy inputs remain unavailable.
- The CLI defaults analysis-aware configurations to offline mode and accepts explicit offline
  overrides of live/frozen preferences. Frozen checking still ignores disposable storage. Local
  cached contract lookup and TypeScript checking initiate no native connection or schema provider.
- The real PostgreSQL proof now acquires through the persistent scheduler, reopens recorded
  evidence without an analyzer claim, temporarily hides durable contracts and passes the actual
  offline CLI using only its persisted native contract. Throwing analyzer/provider factories
  guard this path. It then tests context invalidation and retains the disconnected durable and
  physically stripped programmatic proofs independently.
- Analysis and CLI tests, full typechecking/build, quality, documentation/API/package boundaries,
  packed consumers, the native proof and the performance gate pass locally. Exact-head CI
  remains separate evidence. Analysis coverage is 99.93% lines, 99.11% functions and 94.74% branches.
- Live CLI/config/editor activation, batch query generation/export, freshness coordination,
  project catalog storage, all-engine qualification, compact packs/root migration and generated
  semantic catalog deletion remain required. This checkpoint does not complete that scope.

## Explicit live CLI checkpoint

- Added explicit executable live registration separately from data-only configuration. Registration
  validates factory boundaries and bounded scheduling settings without calling a factory. Offline
  and frozen CLI overrides leave the live factory unloaded; structurally unavailable source fails
  before an analyzer or native adapter is constructed.
- Added finite live preparation over exact candidates. It loads an independent static owner and
  qualifies every distinct candidate, including successful static inference. Bounded workers feed
  the persistent scheduler rather than enqueueing an entire project and evicting earlier queries.
  Per-query and overall deadlines, external cancellation and draining retain owned leases until
  acquisition settles. Native transport cleanup runs before the synchronous compiler view returns.
- Configured target/adapter/reconciliation-owner identities must match the loaded services. Native
  context is inspected before and after the batch. A mismatch retires the recorded context for all
  queries, even without an active query-specific cache record. Live failures cannot fall back to an
  older cached/durable result and report fresh qualification; recorded evidence can still support
  a separately selected offline pass after transport failure.
- The actual `check --live` CLI consumes the resulting synchronous qualified view. Factory-local
  imports are tracked for subsequent config invalidation, including failed construction. Existing
  `verify --live` retains its independent verifier behavior; it is not used as an inference API.
- Synthetic tests cover a batch larger than the scheduler's retained-record bound, duplicates,
  per-context concurrency, successful-static qualification, conflicts/outages, pre/post context
  drift, query-reported context drift, cancellation/deadlines, cleanup failures, incompatible
  services, cold empty projects and source/profile/policy/resource rejection.
- The real PostgreSQL 18.3 helper runs the actual compiled live CLI over an unresolved user-function
  invocation, a statically resolved literal query and a named-parameter SQL-file factory. Durable
  contracts are hidden. A separate offline CLI process reuses all three cached native contracts
  while its analyzer/adapter factories throw if invoked. The database counter proves that native
  qualification does not execute the candidate function. Existing disconnected durable and
  physically stripped programmatic checks remain separate proofs.
- Local analysis/config/CLI suites, full typechecking/build, quality, documentation/API/package
  boundaries, packed consumers and real native proof pass. Analysis coverage is 99.85% lines,
  99.19% functions and 94.96% branches; config coverage is 100% lines/functions and 96.84% branches.
  The performance gate passes locally; exact-head CI remains separate evidence.
- Live checking currently requires the selected recorded context to match the observed context;
  adopting a refreshed context automatically, persisted context-head selection, watch/editor
  regeneration, durable query generation/export, project catalogs, additional transport profiles,
  compact core/packs, root migration and bulk semantic catalog deletion remain required. The
  three-query native proof does not establish all-engine or full statement coverage.

## Durable query generation checkpoint

- Added `generate --queries --live/--offline`, optional qualification-mode override and `--check`
  comparison without durable writes. Generation selects a complete project scope, prepares the
  exact candidate closure and TypeScript-checks the prospective frozen view before export.
  Single-file replacement is rejected; explicit output directories can scope separate projects.
- Offline generation reuses validated available contracts or materializes supported grammar rules.
  Materialization round-trips ordered row/parameter types and result kind through the portable
  consumer. It rejects unrepresentable logical refinements and partial native identities instead
  of silently dropping them or claiming completeness. Native-qualified partial facts continue to
  travel through native evidence. General static-refinement/facet serialization remains required.
- Added an optional recorded result kind and validation against native evidence/command shape.
  Existing artifacts remain readable. Durable file reads share the bounded regular-file/UTF-8
  reader, rejecting symbolic-link artifacts and oversized or invalid data.
- Durable publication now serializes cooperating exporters, checks an expected manifest digest
  and invokes a final project-input fence immediately before the atomic manifest replacement.
  Old manifest objects remain available; failed publication may leave immutable unreferenced
  objects, never a partially published closure. Check-only comparison constructs no durable objects.
- Tests cover two independent exporter processes racing on one baseline, competing replacements,
  final input-fence failure, direct noncooperating manifest replacement, unsafe artifact/lock files,
  deterministic offline generation, SQL-asset sharing, check-only differences, TypeScript failure,
  input changes during preparation, strict qualification and partial/unsupported type rejection.
- The PostgreSQL 18.3 proof runs actual live generation for its three-query project, verifies a
  fresh live `--check` comparison, deletes the isolated live cache and passes actual frozen CLI
  consumption of the generated three-query closure with analyzer/adapter factories guarded.
  The counter still proves candidate description/generation does not execute the user function.
- Local analysis/CLI suites, full typechecking/build, quality, documentation/API/package boundaries
  and the real native proof pass. Analysis coverage is 99.79% lines, 99.2% functions and 94.83%
  branches. Packed consumers, documentation production build and the performance gate also pass;
  exact-head CI remains separate evidence.
- Automatic refreshed-context adoption/head selection, initial context acquisition ergonomics,
  watch/editor regeneration, optional project catalogs/packs, inherited transport contributions,
  all-engine qualification, lightweight root migration, bulk generated semantic catalog deletion
  and the full specification acceptance audit remain required. These commands do not complete
  those broader requirements.

## Observed context selection checkpoint

- Made an explicit recorded context optional when a target/adapter identity is configured. Pure
  installed profile/codec/interpreter identities, schema and decoding policy independently constrain
  accepted native observations. Explicit context pins preserve the preceding behavior.
- Added persisted, bounded context selections per workspace/target/semantic scope. Tokens fence
  competing observations and invalidation; an older response cannot reselect a superseded epoch.
  A changed selected epoch retires old query records and publication leases. Selection timestamps
  remain local sidecars and never establish current remote freshness.
- Live preparation observes and selects a compatible context before constructing static/native
  claims, then checks it again after acquisition. Coherent selection feeds synchronous compilation.
  Empty automatic-context discovery keeps the analyzer cold. Mid-batch context changes invalidate
  support; unknown/failure paths retain their conservative diagnostics.
- Scoped durable manifests bind the selected context to an independently configured target/scope.
  Context-only empty closures are valid, referenced context objects remain bounded/validated, and
  mismatched targets fail. A changed schema/profile/codec scope cannot reuse old facts and can be
  regenerated under the same logical target. Legacy explicit-context artifacts remain readable.
- Automatic offline selection prefers the scoped cache, then compatible durable selection; known
  stale selection cannot fall back to an older durable epoch. With neither, hybrid rules can run
  under an explicitly unobserved offline context. Native-required support still needs qualified
  recorded inputs. Frozen selection reads durable inputs only and never initializes a native owner.
- Added explicit cache snapshot validation for prepared live/offline views. The CLI checks query
  and context publication revisions after TypeScript checking and before durable publication.
  Changed static claims now fence their own record revision without unnecessarily rotating the
  whole context epoch; explicit context changes still rotate the global epoch.
- Factory construction has an explicit discard hook: dependency-tracking failure after native
  resource construction closes the discarded services and preserves original/cleanup errors.
- Tests cover restart/prune preservation, target/schema/codec isolation, competing and delayed
  observations, stale fallback rejection, scoped empty closures, source/metadata snapshot fencing,
  context-free offline generation/frozen reuse, target mismatch and schema regeneration.
- The real PostgreSQL helper omits the context file, generates its three-query closure, changes a
  routine body and observes an automatic epoch change. Live `--check` reports the difference while
  preserving the reviewed manifest; regeneration adopts it. Frozen checks consume the refreshed
  export after cache deletion, and the function counter proves descriptions never execute it.
- Local analysis/CLI/config suites, the full build, typechecking, quality, package/API boundaries,
  packed consumers, documentation checks/build, performance gate and PostgreSQL native proof pass.
  Analysis coverage is 99.31% lines, 99.27% functions and 94.75% branches. Exact-head CI and the
  complete repository acceptance audit remain separate gates.
- Request-driven observation cadence in long-lived hosts, editor/watch integration, complete
  static/native facet authority and refinements, project catalogs/packs, inherited and all-engine
  transport qualification, lightweight root migration, bulk semantic catalog deletion and the
  complete acceptance audit remain required. This is not a claim of full grammar/engine parity.

## Native acquisition failure classification checkpoint

- Native adapters can supply sanitized failure classification directly; explicit host classifiers
  retain precedence. The neutral runner validates returned classifications before publication.
- PostgreSQL preserves the distinction between known statement rejection, context change,
  unsupported evidence and classified connection/temporary availability failures. Raw SQL and
  driver messages are not returned in live outcomes. Unknown failures remain conservative.
- Acquisition and cleanup errors retain both causes. Confirmed negative acquisition results survive
  failed cleanup; successful acquisition cannot publish if cleanup fails. Aggregate classification
  is bounded and gives known context changes priority over availability failures.
- A real PostgreSQL backend is terminated after the first context read and before description.
  Description and rollback both fail; the persistent runner returns transport unavailability and
  the complete prior cache record remains unchanged. Unit tests cover host override precedence,
  persistent rejection, combined failures, recursive aggregates and cleanup/context mismatch.
- Analysis and PostgreSQL package suites pass coverage thresholds; API/package graph contracts,
  TypeScript build checking, changed-file quality and the extended real PostgreSQL proof pass.
  This does not qualify other native transports or finish long-lived host integration.

## Recorded contract editor checkpoint

- The language service loads raw config registrations rather than requiring an eager analyzer.
  Offline documents prepare a contract-first view using the same workspace/config cache namespace
  as the CLI; frozen documents consume only the declared durable closure. Analyzer/provider/live
  factories stay cold for fully covered recorded inputs. Hybrid misses can load the offline owner;
  native-required misses retain unavailable diagnostics.
- Templates and raw SQL use the selected view and policy. Contract identities enter source-analysis
  revisions; unchanged source/version is rechecked when its durable closure changes. A newer known
  analysis revision fences older results. Publication checks complete durable object integrity,
  manifest identity and the captured query/context cache tokens, as well as cancellation/generation.
- Contract manifests and offline cache indexes participate in workspace file watching. Frozen
  editor analysis ignores even corrupt disposable storage. Target/scope validation and automatic
  durable context selection share the neutral host implementation.
- Service tests cover cold factories, SQL/template parity, changed closures, hybrid owner loading,
  strict missing evidence and target mismatch. Built stdio server tests exercise both modes and
  prove contract-derived bigint types reach downstream TypeScript diagnostics.
- The real PostgreSQL proof hides durable contracts and uses the built editor host to recover its
  unknown-function result from native cache evidence, with analyzer/provider factories guarded.
- Local full build/typechecking, all 16 language-server test files, packed consumer/editor tests,
  package/API boundaries, documentation checks/production build, quality and performance gate pass.
  Exact-head CI and the complete repository audit remain separate evidence.
- Live editor scheduling/context observation, SQL-file content-mapper/build-host integration,
  proactive immutable-object corruption watching and project-wide publication coordination remain
  required. Live editor mode reports unavailable without constructing native resources; this is
  not the final live editor implementation.

## Cache read and test fixture quality follow-up

- PR CodeQL findings 61/62 identify a pre-open file check and unnecessary interpolation in a
  generated test module. Cache/artifact reads now open with no-follow/nonblocking flags first,
  validate the descriptor and named-file identity, and read solely through that descriptor.
  A symbolic-link open retains the regular-file diagnostic. The test module uses fixed revision
  literals rather than a string-to-source interpolation helper.
- The symlink regression now points to an existing outside file and directly checks that the
  reader refuses it, so a missing target or invalid downstream JSON cannot hide accidental reads.
- Focused cache/export/config tests, complete analysis/config coverage suites and typechecking
  pass. JavaScript/TypeScript CodeQL check 128642695963 succeeded at `3c63df7b`, and remote
  findings 61/62 report fixed. That evidence does not qualify later changes automatically.

## Request-driven live editor session checkpoint

- Added one owned session per configured editor project, with a shared transport factory and bounded
  scheduler. Context observations coalesce across requests for five seconds by default, with
  `analysis.live.contextIntervalMs` configuration. Native acquisition still checks its own context
  before/after description. Session preparation captures exact document identities and query/context
  publication tokens; closing/editing a document invalidates its old views.
- The finite CLI prepass can borrow the session scheduler without closing shared resources. Session
  context selection publishes once per observation instead of competing with every document batch.
  Identical concurrent query requests share work; cancellation detaches one subscriber without
  cancelling another. Factory/context deadlines do not accept late results, and discarded late
  factories close their resources once. Noncooperative work retains its underlying lease.
- Live editor requests refresh the proxy's TypeScript overlay before coordinate projection and
  upstream requests. A routine change with unchanged source/version therefore produces a new view,
  rather than permanently asking the client to retry an obsolete diagnostic snapshot. Metrics expose
  request-driven observation, last context-check time, connection state and active preparation count.
- Unavailable outcomes do not replace recorded evidence, regardless of retry policy. Configuration
  failures wait for relevant configuration/session changes; transport attempts back off. Hybrid
  fallback for an unsupported native statement class uses independent offline rules and drops prior
  native proof. Partial observations cannot erase a known changed claim or semantic rejection.
  Known changed static claims, conflicts, rejection and stale contexts remain blocking.
- The real PostgreSQL proof keeps the built editor host alive through CLI generation, changes the
  routine body, waits past the observation interval and checks the unchanged document again. Its
  project generation advances and the counter proves regeneration describes rather than executes.
  This is still the restricted PostgreSQL 18 expression-query profile, not all-engine qualification.
- Full-package validation exposed a parallel cache-bootstrap race: ownership may appear between a
  missing-marker read and directory listing. The preflight revalidates the new marker; the existing
  locked initializer remains authoritative. Four-process startup now shares one owner and epoch.
- Local build/typechecking, analysis coverage, language-server suite, packed consumers/editors,
  API/package graph boundaries, quality, docs checks/build and real PostgreSQL proof pass. Exact-head
  CI remains separate. Analysis coverage is 98.56% lines, 99.34% functions and 93.08% branches.
- Rich pending/queue diagnostics and noncooperative queued-response budgets, explicit editor refresh,
  optional qualified idle notifications, project-wide dependency publication, declaration cache
  persistence, CLI watch orchestration, content-mapper/build-host integration, optional catalogs/packs,
  compact cores, all-engine profiles, root migration, bulk catalog deletion and final acceptance remain
  open. Request-driven sessions do not claim idle remote-change detection or complete host parity.

## Runtime codec projection checkpoint

- PostgreSQL and MySQL runtime type-policy helpers load generated codec projections rather than
  full routine/operator/cast catalogs. Identical version tables share one immutable mapping;
  generated source sizes are 2,801 and 2,490 bytes respectively. PostgreSQL compatibility retains
  the existing per-version catalog revision hashes. Semantic catalogs and codecs share type-name
  normalization. Projection tests compare every declared version, mapped name and alias against
  the existing analyzer policy, including absent/unsupported version behavior.
- The packed-consumer proof discovers all five grammars from the feature ledger, removes semantic
  catalog JavaScript and resolver/root modules from a disposable install, then imports each public
  driver-neutral runtime entrypoint. Essential type/alias/coercion projections remain available.
  A PostgreSQL application-owned fake pool additionally verifies planned bigint decoding and
  invalid-value rejection. This is import/boundary evidence, not native transport qualification
  for the other engines or complete physical stripping of the CLI host.
- PostgreSQL/MySQL suites, projection parity, generator reproducibility, public API/package graph,
  packed consumers, typechecking, quality and the restricted real PostgreSQL contract proof pass.
  The concurrent performance run exceeded the large-query parser p95 budget (39.83ms versus 30ms);
  an isolated rerun with unchanged budgets passes. Performance evidence is collected without
  competing coverage/packing jobs; the earlier concurrent failure remains recorded here.
- Root/analyzer and explicit driver entrypoints still load heavy semantics; all bulk semantic
  catalogs remain shipped. This checkpoint establishes the runtime codec boundary, not production
  bundle savings, compact-core/pack migration, all-engine qualification or bulk catalog deletion.

## Built-in lightweight profile checkpoint

- MySQL, SQLite, SQL Server and DuckDB now expose explicit `/profile` modules alongside PostgreSQL.
  Existing analyzer factories compose those same profile mechanics, removing duplicated rendering,
  placeholder extraction, policy selection and snapshot validation rather than maintaining a second
  implementation. Existing root runtime exports remain unchanged. Profiles contain no analyzer
  factory or native connection loader; development hosts register their contributions explicitly.
- DuckDB preserves parser-based contextual marker extraction. Its syntax parser and compact type
  aliases remain profile dependencies; struct separators, slice colons and lambda syntax cannot be
  replaced with a lexical guess. This checkpoint does not claim unknown-syntax parameter coverage.
- A ledger-discovered packed proof imports all five profiles in a fresh process with root/browser,
  resolver, semantic catalog and provider modules absent, checks their IDs, lack of analyzer/loaders,
  positional parameter indexes/spans, and wrong-dialect snapshot rejection. Runtime imports are
  checked in a separate process before providers are stripped: SQL Server's existing live-verifier
  runtime export still depends on its provider. That runtime boundary remains required work.
- The affected grammar suites pass: MySQL 27 files, SQLite 16, SQL Server 23 and DuckDB 42. Public API,
  package entrypoint and documentation contracts pass; packed consumer/editor/native-editor tests,
  TypeScript checking, quality, production documentation build and isolated performance gate pass.
  Documentation lists the profile boundaries and DuckDB's
  contextual extraction requirement. This is an incremental profile boundary, not lightweight-root
  migration, native transport qualification or removal of bulk generated semantic catalogs.

## CI fixture and live deadline follow-up

- CI at `1e342f1f` reports a successful CodeQL check but is not green overall. Source verification
  exposed a noncooperative context-read request whose `AbortSignal.timeout` timer did not keep Node
  alive; an unrelated test timer could hide it locally. Context requests now own referenced deadline
  timers and clear them after settlement. The regression awaits the request without an unrelated
  timer. All 15 analysis test files pass (98.45% lines, 99.34% functions, 93.14% branches).
- The editor host's independent packed installer and real-database packed fixture omitted the new
  analysis dependency. Both now discover workspace production dependency closures instead of requiring
  every transitive package to be declared manually. Editor grammar roots come from the feature ledger.
  The actual editor installer smoke packs/installs 16 local archives including analysis; editor/package
  boundary contracts pass. Full Electron and real-database matrix reruns remain separate evidence.
- PostgreSQL's native-contract E2E caller now derives the repository path from its file URL rather
  than the package working directory. The complete restricted PostgreSQL native/cache/editor/CLI
  proof passes when invoked from the E2E package directory. This does not qualify other engines.
- Added an unknown-preserving declaration for the shared metadata canonicalizer so the complete
  packed E2E TypeScript input closure can be checked; that check now passes. Root incremental
  TypeScript build and quality also pass.
- Remote build integrations still report SQL-asset declaration conflicts; native SQL Server and
  other failing CI lanes need independent investigation. These local fixes do not certify remote
  matrix success, full architecture acceptance or bulk catalog removal.

## SQL declaration compatibility follow-up

- The build-integration conflict compared build-owned SQL declarations, which include an ownership
  comment, with the compiler's current comment-free projection. Compiler/build now share the exact
  ownership marker. Compatibility comparison removes only that marker and normalizes CRLF; changed
  declaration contents still conflict, including incorrect files carrying the marker. Virtual checking
  continues to use independently generated current evidence rather than trusting adjacent declarations.
- Regression coverage accepts current declarations with CRLF and rejects stale owned and unowned
  declarations. All 20 compiler test files and the build suite pass; the new comparison module has
  complete line/function/branch coverage. Public API/package contracts and incremental TypeScript
  build pass. The actual packed DuckDB integration passes for both native SDKs, and the Next.js
  integration passes for Turbopack and webpack. These are existing build flows, not qualification of
  contract-only build-host integration with physically absent analyzers.
- Metadata canonicalizer declarations now preserve recursively canonicalized record/array shapes,
  convert bigint fields to strings and leave unknown input unknown. The entire packed E2E TypeScript
  closure passes without weakening checks. Generator provenance reports are refreshed from the clean
  committed corpus; unrelated pending MySQL metadata remains outside this checkpoint.
- New-head remote CI, native SQL Server audit failures, full Electron/native matrices, root migration,
  compact-core/pack selection and bulk semantic catalog deletion remain open.

## Lightweight runtime roots and explicit semantic entrypoints

- All five grammar roots now expose SQL, runtime plan primitives, rendering and compact type-policy
  mechanics. Eager analyzer factories and the previous full root export surfaces move intact to
  `/analysis` compatibility entrypoints. The existing full API inventories are asserted separately
  from the new small roots. This is a declared major API migration; application `sql` imports stay
  at the selected root. Profile constructors remain on `/profile` so ordinary runtime root imports
  do not load statement parsers, including DuckDB's contextual parameter parser.
- Repository consumers and embedded configuration fixtures use explicit analyzer imports. New CLI
  scaffolds and quickstarts register a profile plus a separate lazy analyzer contribution. Frozen
  configuration can omit the contribution. Third-party grammar fixtures retain their own declared
  analysis module, with no neutral-package built-in grammar allowlist.
- The ledger-discovered packed boundary proof removes semantic inventories, analyzers, providers,
  declarations and maps. Every root imports and type-checks without those files. Profiles work in a
  separate process, retaining DuckDB's contextual parser. A second runtime-only installation removes
  profile implementations and entire statement-parser directories; all five roots still construct
  SQL values. Essential scalar codec/type projections remain intentionally available.
- The real PostgreSQL proof now installs actual public tarballs and checks its acquired qualified
  native closure through the full frozen CLI with analyzer/parser/catalog/driver modules absent.
  It preserves bigint/nullability, rejects an incompatible downstream TypeScript assignment and
  recompiles identically through the programmatic loader. Factories are guarded, JavaScript network
  traps are active and the database counter remains one. Tool dependencies follow packed-consumer
  overrides; this is not an OS network sandbox or all-engine qualification.
- Local clean build, incremental typechecking, grammar/core/compiler/config/analysis/conformance,
  CLI/build/playground, editor and synthetic grammar suites pass. The first aggregate source run
  exposed one stale embedded editor-fixture analyzer import; its focused service test passes after
  correction. All 68 contract files, packed consumers/editors, documentation production build and
  isolated performance gate pass. Exact-head CI remains separate evidence.
- The diagnostic audit also discovers every production source tree rather than a manually maintained
  emitter list. It exposed existing unregistered DuckDB, SQL Server and preparation codes, now added
  to the machine registry and complete reference. Retained stable codes need no fake current emitter.
- Runtime roots are separated; explicit driver adapters, selected compact cores, version/pack loading,
  reusable project catalogs and bulk generated semantic TypeScript deletion remain required. All
  full semantic catalogs still ship through the compatibility distribution. No installed-size or
  application bundle savings percentage is claimed by these module-boundary proofs.

## Lazy driver introspection and discovered runtime export audit

- All five grammar adapters share provider DTOs through cold contract modules and load schema
  discovery implementations inside `introspect()`. PostgreSQL and SQL Server execution retain
  their exact server/session evidence queries and validation through dedicated modules. Existing
  provider exports and PostgreSQL extension error identity are preserved.
- PostgreSQL extension manifests still explicitly opt into semantic resolution during database
  construction. That path is intentionally not certified as independent of semantic catalogs.
- Grammar manifests classify development-only entrypoints. The packed audit discovers every
  other public export automatically and imports it after semantic inventories, provider modules,
  declarations and maps are removed. Future exports enter the runtime audit by default; root and
  runtime exports cannot be excluded. Existing profile and parser-free root proofs remain active.
- All 144 grammar test files, three packed-consumer suites, public API/package graph/diagnostic
  contracts, incremental TypeScript build and quality pass. Quality retains the existing 121
  warnings and two informational diagnostics. The complete restricted real PostgreSQL native,
  cache, editor and packed frozen CLI proof passes after the split. These results do not qualify
  native contracts on other engines or establish package-size savings.
- Full semantic compatibility catalogs still ship. Selected compact cores, optional packs,
  reusable project catalogs and bulk generated semantic TypeScript removal remain required.

## Serialized CLI watch and native result drift

- `check --watch` runs the existing one-shot command in a fresh owned process for each pass.
  Ordinary/offline/frozen/live policy and qualification behavior stay with the existing checker.
  Edits debounce for 250 ms, active checks serialize and coalesce changes, and failed checks keep
  watching. Config/source/schema and discovered external inputs refresh between passes; durable
  contract directories are observed without exporting them.
- Directory discovery skips dependency, Git and disposable cache trees before creating directory
  watches. Creating a cache parent observes its siblings without scheduling cache feedback loops.
  Shutdown cancels discovery and stops the active check, escalating a noncooperative process after
  one second. POSIX checks own a process group. Node's early AbortError no longer releases a
  TypeScript discovery process before its close event.
- The compiled CLI tests cover new source discovery, error/recovery, external schema and eager
  configuration dependencies, ignored cache writes, invalid flags and noncooperative shutdown.
  The compiler regression cancels an actual discovery subprocess and checks that it has exited.
  All 11 CLI and 20 compiler test files pass; compiler coverage thresholds pass. All 68 contract
  files, quality, E2E PostgreSQL helper typechecking, documentation production build and isolated
  performance gate pass.
- The real PostgreSQL watch proof replaces a bigint routine with a text routine while the watcher
  stays alive. A source edit triggers native requalification and TS2322 on the stale bigint claim;
  restoring the routine recovers. Candidate SQL is never executed. The complete existing native,
  editor, offline and independently packed frozen CLI proof still passes.
- This is request-driven file watching, not idle database polling. Inherited project configuration
  outside discovered roots, lazy external contribution dependency reporting, complete host graph
  invalidation and all-engine watch qualification still need explicit acceptance evidence.
- Remote checks at driver checkpoint `fa41d4f6` show all four SQL Server native transport lanes,
  DuckDB/Next.js build integrations and CodeQL succeeding. The complete 58-check observation
  exposes stale eager-root imports in crash-worker/UI fixtures and the runtime benchmark. Those
  failures also block the aggregate quality job; they require a separate compatibility follow-up.

## Embedded eager-root consumer follow-up

- The completed driver-head CI run found compressed/dynamic consumers missed by the root import
  migration: the PostgreSQL crash worker, packed browser agent fixture and runtime benchmark
  metadata/configuration/compiler setup. These now select `/analysis` explicitly; benchmark
  application execution still imports `sql` from the runtime root.
- The actual two-case PostgreSQL process-crash test passes with a separately created disposable
  scratch database. The packed browser agent suite passes in Chromium. A MySQL 8.4.11 smoke run
  exercises SQL-file, compiled-inline and ordinary-inline benchmark paths against an isolated
  temporary database. Benchmark dependencies were first refreshed from their frozen lockfile;
  its existing driver-version equality check correctly rejected stale local dependencies.
- The smoke uses one warm sample and verifies execution/import compatibility, not statistically
  useful performance evidence. The isolated macro performance gate passed at the watch checkpoint.
  Full new-head CI and the broader architecture acceptance audit remain required.

## Selected PostgreSQL native-signature profiles

- Shared analyzer construction, resolver and semantic mechanics receive their native catalog
  explicitly. Compatibility wrappers retain the previous `/analysis`, private resolver and routing
  behavior. Lookup indexes are keyed by catalog identity, so contributions with the same major
  cannot reuse each other's overload indexes.
- Generated signatures partition by exact major membership. Fixed-major public factories and an
  asynchronous selector load one native profile; snapshot evidence must match the selected major.
  The ordinary compatibility entrypoint still loads every retained profile. Shared type/cast
  registries remain eager across all six versions. This is not yet compact-core or optional-pack
  selection and does not delete the full semantic distribution.
- Deep comparison with the preceding generated module preserves all 19,857 ordered signature
  records across PostgreSQL 14–19. Tests discover the majors from the feature ledger, check their
  public packaging registrations and compare complete analysis results between compatibility,
  async-selected and fixed factories. Unsupported/missing/mismatched version evidence fails closed.
- Each major runs in a separate packed package copy after unrelated native profile/group files,
  compatibility analyzers, providers and their declarations/maps are removed. Both selected APIs
  work; the fixed factory also bundles and executes with only its native profile in the graph.
  Declaration checking uses the independent packed consumer's TypeScript executable. The separate
  frozen proof now removes the new factory/engine modules and generated analyzer entrypoints too.
- All 37 PostgreSQL test files and coverage thresholds, all 68 contract files, incremental root
  typechecking, quality, documentation production build and isolated performance gate pass. The
  complete local restricted PostgreSQL native/editor/watch/offline/packed frozen CLI proof passes.
  Generation bootstrap still works without host implementations or package manifests. Packaging
  validation stays in the tests rather than making the generator read host implementation metadata.
- The reproducible measurement script compares ordered records against commit `417c1d30` and
  reports minified/gzip/Brotli factory footprints, native profiles, remaining eager type profiles
  and input digests. [Committed-input measurements](./postgres-selected-measurements.json) at
  `ae5ea0af` record PostgreSQL 18 factory gzip at 131,763 bytes versus 179,686 for the compatibility
  factory (26.7% smaller). This is not application runtime or installed-package savings.
- Newer merge-ref CI still reports a conservative stale-context rejection during PostgreSQL watch
  recovery and an eager-root import in a browser fixture introduced on the advancing base branch.
  Those are separate follow-ups; the local results do not certify the full merged PR matrix.

## Base integration and bounded automatic context refresh

- Merged current `main` through `37535711` after verifying its incoming paths did not overlap
  pending local work. All 31 pending files remain byte-for-byte unchanged. The newly introduced
  browser analysis fixture now imports the explicit PostgreSQL analysis entrypoint.
- Finite live preparation retries confirmed context drift only when context selection is automatic.
  At most three attempts share the existing batch deadline. Each attempt drains scheduler and
  service cleanup before acquiring again. Explicit pins, incompatible scopes, ordinary failures,
  failed cleanup and cancellation do not trigger this retry. PostgreSQL's WAL guard is unchanged.
- Candidate SQL/layout remains snapshotted across attempts. Cancellation during cleanup prevents
  returning a view, including for pinned contexts. Tests cover drift/recovery, captured SQL,
  non-overlapping ownership, persistent drift, cleanup failure and cancellation. Watch completion
  now distinguishes queued changes from waiting for another edit.
- All 15 analysis and 11 CLI files pass, including coverage thresholds. Root clean build, all
  68 contracts, quality, documentation build and isolated performance gate pass. The language
  server's 16 files, bridge's six files and playground's 32 files pass against the merged base.
  The real PostgreSQL native/editor/watch/offline/packed frozen proof and the previously failing
  packed browser analysis suite pass locally. Full new-head remote CI remains separate evidence.
- The selected-analyzer measurements are formatted for the repository's JSON rules without
  changing any measured values. Bulk generated-catalog deletion, compact cores, other selected
  grammars and the remaining complete acceptance matrix are still required.

## Selected PostgreSQL core catalog isolation

- Fixed-major analyzers import only that major's core catalog as well as its native signature
  profile. The asynchronous analyzer loads both selected profiles together. The full compatibility
  entrypoint still selects from every retained major and preserves its existing fallback policy.
- Cold catalog lookup, type resolution and extension resolution no longer import the all-major
  registry. An analyzer owns a shallow frozen snapshot clone associated with its explicit catalog;
  caller snapshots are neither mutated nor globally registered. Catalog indexes and deep-freeze
  admission are keyed by catalog identity. Extension snapshot upgrades and contribution results
  preserve that ownership. Legacy private helpers retain their prior default selection behavior.
- Packed verification removes unrelated core profiles, the all-major registry and legacy catalog,
  extension and type-resolution wrappers before importing or bundling the selected APIs. Bundle
  attribution rejects extra core profiles as well as extra native profiles.
- Verification passes: full clean build; all 37 PostgreSQL test files with 97.57% line,
  90.52% branch and 97.68% function coverage; all 68 repository contracts including physically
  stripped selected consumers; quality; production documentation; the complete restricted real
  PostgreSQL native/editor/watch/offline/packed frozen proof; and the isolated performance gate.
- Committed-input measurements at `8e2947fb` retain exactly one native and one core profile
  per selected graph. PostgreSQL 18 is 1,378,491 minified bytes / 129,723 gzip / 99,724 Brotli;
  compatibility is 1,690,274 / 179,392 / 103,302 respectively. The selected factory is 27.7%
  smaller gzipped than compatibility. The runtime-root sample remains 17,767 / 5,645 / 5,102.
  These are factory footprints, not application workload or installed-size savings.
- This removes unselected core data from selected analyzer graphs. Full compatibility data still
  ships in npm; compact common-function cores, optional packs and bulk deletion remain required.

## Selected DuckDB engine catalog isolation

- Add fixed exact-version analyzer entrypoints and an asynchronous selector for every retained
  DuckDB engine version. The generator owns profile modules and loading targets; ledger-driven
  tests require complete manifest coverage. The compatibility `/analysis` and `/browser` APIs
  retain their automatic selection and previous exports.
- A catalog instance owns immutable signatures, formal parameter bindings, literal constraints,
  named-argument policy, implicit casts and both common-type matrices. Resolver, overload matching
  and named binding receive that catalog explicitly; they do not import the all-version registry.
  Selected analyzers fail closed without matching exact server-version and semantic-setting evidence.
- Tests compare all retained signatures and parameter metadata with the original generated data
  and compare complete selected/fixed/compatibility results. Native named-argument tests exercise
  selected analyzers against the actual 1.5.6 and 2.0.0 SDK installations. Packed tests remove the
  other engine's data/matrices, compatibility registries, wrappers and declarations/maps, then run,
  bundle and type-check the remaining selected APIs. Source attribution rejects unrelated profiles.
- Verification passes: clean root build and final project/test type checks; all 43 DuckDB files
  against both native SDK installations, with 98.83% line / 91.01% branch / 96.09% function coverage;
  all repository contract files after correcting the new documentation and packed assertions;
  quality, production documentation and the isolated performance gate. The packed assertion uses
  an explicit VARCHAR parameter cast because ordinary offline `lower($1)` retains `ANY` input.
- Shared measurement tooling records source digests, pinned data parity and consistent minified,
  gzip and Brotli settings for PostgreSQL and DuckDB. These measurements do not claim application
  workload savings or an npm installation-size reduction.
- Committed-input measurements at `267085ca` preserve both original generated DuckDB profiles
  byte-for-byte at the semantic export level. The compatibility factory is 1,374,100 minified /
  103,822 gzip / 61,356 Brotli bytes. Selected 1.5.6 is 734,277 / 68,516 / 54,494 (34.0% less gzip);
  selected 2.0.0 is 764,695 / 71,746 / 56,926 (30.9% less gzip). The runtime-root sample remains
  17,864 / 5,660 / 5,113. PostgreSQL measurements retain their previous values after sharing the
  measurement harness. See `duckdb-selected-measurements.json` and `postgres-selected-measurements.json`.
- Full semantic catalogs still ship. Compact cores, optional packs, other selected grammars and
  all-engine query-contract qualification remain required.

## PostgreSQL compact offline core and complement packs

- Add a reviewed initial policy of 200 native function names with MIT synthetic application
  scenarios; this is not a measured production popularity ranking. Retain complete overload
  families for each selected name and all existing shared semantic/type/cast rules. Across the
  six retained majors the projection contains 197–200 native names and 437–470 signatures,
  compared with 3,191–3,426 signatures in the complete projected profile. The selection audit
  records both populations and shared family counts separately.
- Partition native records into the core and its compatibility complement, sharing identical
  records only among owning versions. Legacy full arrays reference those records directly and
  preserve all 19,857 ordered entries; they do not load intermediate profile arrays. Remove the
  retired unsplit group modules. This is a distribution split, not bulk catalog deletion.
- Publish a compact all-version entrypoint, fixed-major cores and explicit major-specific
  compatibility packs. Packs contain only the long tail, bind the exact core digest, grammar
  revision and type/cast catalog revision, and describe source-projected facets rather than
  native query qualification. Reject incompatible dependencies and conflicting signatures.
  Existing full analyzers retain their API and semantics; duplicate packs do not duplicate overloads.
- New PostgreSQL scaffolds and quickstarts lazily load the core. Long-tail calls remain unknown
  with diagnostics until supplied by a matching pack, declared schema routine or native contract.
- Tests discover every supported major from the ledger, compare complete selected families and
  corpus results, exercise pack admission and restoration, and run packed fixed cores with the
  full native and compatibility projections physically removed. The real restricted PostgreSQL
  live/editor/watch/frozen proof now registers the compact analyzer during live analysis.
- Verification passes: clean build, final TypeScript project checks, all 38 PostgreSQL files
  (97.59% line / 90.62% branch / 97.76% function coverage), all 11 CLI files, all 68 repository
  contracts, quality, production documentation and the restricted native proof. After removing
  avoidable legacy array assembly, the five affected source/packed/bootstrap files pass again.
  The final isolated performance recheck passes after that assembly change. Committed-input
  bundle attribution is recorded separately.
- Committed-input measurements at `1f498aac`: compact all-version factory 559,455 minified /
  79,539 gzip / 64,528 Brotli bytes versus full compatibility 1,687,142 / 179,402 / 104,008
  (55.7% less gzip). Fixed PostgreSQL 18 core is 411,192 / 76,701 / 63,457 versus its full
  selected analyzer 1,377,998 / 129,378 / 100,384 (40.7% less gzip). Core plus its long-tail pack
  is 1,380,131 / 130,307 / 100,449. Runtime-root bytes remain 17,767 / 5,645 / 5,102.
  These are analyzer footprints; full compatibility installation data remains present. This
  does not claim a query-runtime saving or a production popularity-weighted coverage percentage.
- Remaining: equivalent compact cores/packs for the other grammars, broader real application
  workload selection evidence, richer project catalogs, pack/contribution identity integration
  across every host and bulk generated-code removal. This does not qualify additional native
  transports or close the complete architecture acceptance audit.

## Disposable package projections and source-tree removal

- Remove all 105 generator-owned package TypeScript projections from Git: 36,467 previously
  tracked lines and approximately 4 MB of source. This includes native catalogs, core/pack/profile
  projections, type policies and generated vocabularies across all five grammars. Retain reviewed
  facts, locks, policies, normalized inventories and ownership/digest reports in Git. This changes
  repository ownership; published packages still contain their compiled selected/compatibility data.
- Derive projection ownership from registered emitter outputs, without enumerating grammars or
  versions. The private workspace postinstall and `catalog:check` materialize missing projections
  only after durable provenance and every existing output match. They do not bless stale reports
  or overwrite changed source. Missing-only publication uses complete temporary files and atomic
  no-overwrite links, accepting another writer only when its bytes match.
- Explicit generation removes retired package projections only when their ownership header and
  old recorded byte digest match. Cleanup validates every candidate first, refuses symbolic-link
  paths or changed owned files and leaves authored neighbors alone. Clean builds remove owned
  projections and regenerate before compilation. Materialization compares bytes, not lossy UTF-8
  decoding. Tests cover stale durable inputs, changed outputs, concurrent materialization,
  retirement, altered retirement candidates, ignored/untracked ownership and symbolic links.
- A source tree exported from the staged index started with all 105 projections absent. A real
  `pnpm install --frozen-lockfile` materialized every file with the committed manifest's digest,
  and its full clean build passed. The primary workspace clean build also passed and reproduced
  all 105 original working-file hashes exactly, including the pending MySQL generated outputs.
  The MySQL projections remain locally present but become ignored; their maintained policy and
  resolver changes remain pending and are not included in this commit.
- All 68 repository contract files, production documentation, TypeScript project checks, quality
  and the isolated performance gate pass. A formatting issue and an unused test import found by
  quality were corrected; the affected emitter suite and targeted quality checks pass again.
- Bundle measurement provenance now accepts ignored projections only when their exact bytes match
  the committed ownership manifest, recording that manifest digest and every such input separately.
  Fresh committed-input measurements are separate evidence; installed-size and native qualification
  claims do not follow from deleting generated source from Git.
- Remaining architecture work includes other compact cores/packs, all-engine native contract
  qualification, project catalogs and complete cross-host contribution/facet acceptance. Removing
  tracked projections does not finish those requirements.

## Required work still open

1. Complete the contract/evidence model: native descriptors and provenance, reusable/facet-specific
   qualification, parameter authority/layout, result kinds and scoped semantic facts.
2. Native acquisition independent of resolved compiler manifests, registered owners and strict
   project-wide native qualification, including disagreement handling.
3. Real database vertical proof with compiled decoding and disconnected reuse; qualify the five
   engine/transport profiles and explicit limitations.
4. Complete the remaining frozen configuration/CLI and build-host matrix with durable closures and
   native qualification. The restricted real PostgreSQL whole-project frozen CLI now works with
   heavy modules physically absent; that does not qualify every transport, variant or host.
5. Complete cache/scheduler host integration, context observations and project catalog/declaration
   persistence; qualify ownership, admission, cross-process interruption/recovery and pruning in
   the actual CLI/editor workflows. Concrete query storage and process tests are implemented above.
6. Complete explicit offline/frozen/live configuration and CLI generation/check/watch acceptance.
   Serialized triggered watch is implemented above; inherited/external graph coverage remains open.
7. Integrate the bounded live scheduler with editor/project invalidation, request-driven context
   freshness, persistent restart reuse and finite batch generation.
8. Finite/repeated structural variant coverage, ambiguous/repeated parameters, unsupported syntax
   fallback and conservative runtime effect/routing behavior.
9. Complete selected core/profile/pack loading and explicit extension runtime boundaries.
   Root/profile separation, ordinary driver boundaries and the major `/analysis` API migration are implemented above. Preserve
   existing supported semantics through explicit compatibility packs before removing bulk catalogs.
10. Optional project catalogs and contributed extension reuse behind qualified inference permission.
11. Public documentation, diagnostics, release/distribution contracts and after-implementation
    bundle/latency/workload measurements.
12. Full repository/native/packed/editor/performance gates, review resolution and a requirement-
    by-requirement audit of all acceptance scenarios before marking the objective complete.
