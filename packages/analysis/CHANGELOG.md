# @typed-sql/analysis

## 3.0.0

### Patch Changes

- @typed-sql/core@3.0.0
  - @typed-sql/schema@3.0.0

## 3.0.0-rc.0

### Minor Changes

- 63e76b2: Add read-only analysis cache inspection, CLI cache status and pruning, semantic query/declaration export diffs with JSON output and current callers, and recorded evidence origin/context in editor hovers. Cache inspection reports unverified freshness and does not initialize storage or native services.
- 63e76b2: Load selected project catalog interpreters lazily in CLI, build and editor hosts, and carry the enriched schema through checking, transforms and declaration generation. Offline checking can reuse qualified declarations for new queries, while frozen checking requires exact contracts. Preserve base-context retirement evidence when checking derived catalog inputs, and track catalog objects and local interpreter modules as dependencies.
- 63e76b2: Add an explicitly opened disposable query-contract cache with validated restart reuse, workspace namespaces, atomic immutable-object/index publication, cross-process locking, invalidation tokens, bounded admission and reference-preserving pruning. Cached evidence reports unverified remote freshness and remains separate from durable compiler inputs. Load filesystem locking only when the cache is opened.
- 63e76b2: Add explicit live/offline query-contract generation and check-only export comparison. Generation
  checks the prospective contract view with TypeScript and fences source/config/schema/project inputs
  before publishing a complete durable closure. Native-required qualification cannot fall back to an
  ordinary offline result.
  
  Serialize cooperating exporters, compare the selected manifest before replacement, and reject
  unsafe artifact files. Preserve recorded result kind and reject offline materialization that would
  lose logical type refinements or misrepresent partial native identity.
- 63e76b2: Add lightweight dialect registrations with explicit lazy analyzer loading and frozen CLI checks
  against validated durable query contracts. Frozen checks validate interpreter, schema, decoding and
  qualification identities without opening disposable caches, initializing analyzers or invoking
  database providers. TypeScript project checking supplies SQL-file factory declarations in memory.
  
  Expose PostgreSQL contract compatibility identities through a pure contract-profile entrypoint.
- 63e76b2: Add explicit native project-catalog acquisition with automatic context observation, guarded
  before/after validation, cancellation and owned cleanup. PostgreSQL captures matching routine
  families on one leased connection using metadata-only queries and the shared introspection
  mapper. Reject truncated families, unsupported selections and mismatched server evidence.
  Metadata collection does not prepare or execute the selected application statements.
- 63e76b2: Add an explicit asynchronous query-contract refresh scheduler with shared requests, bounded queues and concurrency, generation-based invalidation, cancellation fencing, deadlines and classified retry backoff. Qualified results publish through an immutable view for synchronous compiler consumers; importing the APIs does not initiate database access.
- 63e76b2: Add explicit live adapter registration and finite native qualification before CLI TypeScript
  checking. Qualify every extracted candidate, including successful static inference, through bounded
  workers and the persistent scheduler. Check recorded context before and after acquisition, retire
  incompatible context evidence, and close owned transport resources before synchronous compilation.
  
  Offline and frozen overrides leave native factories unloaded. Track local modules imported by
  explicit contribution factories so subsequent configuration loads detect their changes.
- 63e76b2: Allow native adapters to classify acquisition failures without host-specific wiring. PostgreSQL
  connection loss and temporary availability failures preserve recorded evidence, while confirmed
  statement rejection and context changes invalidate it. Acquisition and cleanup failures retain
  both classifications so a rollback outage cannot hide a known invalidation.
- 63e76b2: Support live context discovery and refresh without a pre-recorded context file. Bind recorded
  selection to the configured target, schema, installed profile and decoding policy; fence competing
  observations and retire prior query evidence when the selected epoch changes. Explicit context pins
  retain their behavior.
  
  Include target/context selection in durable manifests for offline and frozen consumption. Frozen
  checks ignore disposable observations; hybrid offline rules remain available without claiming a
  native observation. Revalidate context/query cache snapshots before publishing generated inputs.
  
  Dispose constructed native services if subsequent configuration dependency tracking fails.
- 63e76b2: Consume durable query contracts in build transforms and SQL declaration generation. Frozen builds use recorded inputs without initializing analyzers or native services. Offline and live-configured builds can use offline rules for unrecorded queries; builds never invoke live factories or read the disposable development cache. Track the validated contract closure in cache keys and watched dependencies, including lazy analyzer dependencies in source-aware Jest keys, and reject inputs changed during preparation or publication.
  
  Explicit query-contract generation checks prospective SQL types over stale build-owned declarations in memory, allowing changed queries to regenerate their contracts before declarations are rewritten. Application-owned declarations and incorrect application assignments remain blocking; ordinary checks still reject stale declarations.
- 63e76b2: Add exact recorded-context cache lookup before analyzer loading, offline contract-first project
  checking, and explicit persistent live producers. Hybrid offline checks load an analyzer only for
  uncovered statements; native-required misses and known negative evidence remain conservative.
  
  Fence cache publications across changed static claims and preserve matching recorded evidence on
  transport outages. A known stale context blocks all lookups in that recorded context until fresh
  qualified acquisition restores it. Explicit live producers always acquire independent evidence.
- 63e76b2: Persist selected catalog closures in the owned analysis cache with independent base-context and
  selection publication fences. Live editor sessions capture through a shared native owner, reuse
  valid document views, and bound refresh work, cancellation and cleanup. Offline checks recover
  matching cached selections with independently installed interpreters. Explicit live CLI checks
  can capture selected catalogs without exporting durable artifacts.
- 63e76b2: Persist selected project catalogs atomically with query contracts. Catalog closures retain base and enriched context identities, and frozen loading recomputes their schema through independently installed contributions. Exports without catalogs preserve the existing manifest format.
- 63e76b2: Add owned project live-analysis sessions with shared bounded query scheduling, coalesced
  request-driven context observations, cancellation and guarded view publication. The language server
  uses explicit live adapter registrations, refreshes TypeScript overlays after context changes and
  reports connection/observation status. Offline and frozen modes keep native factories unloaded.
  
  Preserve recorded evidence for availability/configuration failures independently of retry policy.
  Hybrid analysis may use independent offline rules for unsupported native statement classes;
  known changed claims, native rejection and conflicts remain blocking.
- 63e76b2: Introduce validated, content-addressed query contracts and a synchronous frozen dialect consumer.
  Contracts preserve exact query/context/codec bindings and derive application types from validated
  runtime descriptors. Explicit durable exports publish immutable context/query objects through an atomic
  manifest; import validates the declared closure without falling back to local caches. Missing contracts and incompatible contexts produce conservative diagnostics.
  
  Add explicit native acquisition sessions and validated facet evidence. Native evidence preserves
  unknown nullability and partial identities, binds parameter occurrences and context revisions,
  and must agree with emitted runtime descriptors. Acquisition guards context, supports cancellation,
  and closes its session before returning a contract.
  
  Add independent static/native reconciliation, explicit nullability certainty and persisted
  qualification proofs. Consumers can require an exact qualification policy; known conflicts,
  unavailable required facts and unverified known claims cannot produce qualified artifacts.
- 63e76b2: Capture and refresh selected catalogs during explicit live query generation. Keep base native identities independent of the enriched compiler schema, qualify queries against the derived context, and publish the catalog closure with query contracts. Bound retries and owned cleanup on context drift or cancellation. Hybrid live preparation retains independent offline rules for adapter-excluded statement classes; native-required qualification remains blocking.
- 63e76b2: Add bounded, context-bound project catalog data with explicit grammar interpreters and inference
  permissions. PostgreSQL selects complete routine families from introspected metadata using SQL
  calls and permits offline reuse of qualified fixed scalar results. Preserve parameter/default
  metadata, recompute types from the configured policy, keep results nullable, and require exact
  query evidence for unsupported declaration forms. Catalog selection changes analysis identity;
  conflicting owners, changed contexts and unsupported permissions fail closed.
  
  Record qualified native PostgreSQL argument/result type identities during introspection. Strict
  null-input behavior no longer incorrectly marks an introspected routine's result as non-null.

### Patch Changes

- 63e76b2: Give native context drift, cache publication conflicts and invalidated analysis views distinct error names so editor diagnostics identify their failure category without exposing SQL or native driver messages.
- 63e76b2: Refresh automatically observed contexts after confirmed drift in finite live checks and generation,
  with at most three attempts sharing the existing batch deadline. Wait for owned cleanup between
  attempts, preserve explicit pins, and honor cancellation through cleanup. Watch status distinguishes
  queued edits from waiting for changes.
- 63e76b2: Open recorded cache and artifact files through a no-follow descriptor before validating their
  regular-file identity. Reads use that descriptor and reject replaced paths, symbolic links,
  nonregular files, excessive sizes and invalid UTF-8.
- 63e76b2: Observe native context again when a shared cache publication fence changes, even inside the context observation interval. Fresh views use the new fence while earlier views remain invalidated.
  
  Automatically scoped live sessions also retry explicitly classified acquisition drift up to three times with fresh context observations under one batch deadline. Explicit context pins remain fixed, and failed native leases close before another attempt.
- 63e76b2: Serialize publication-lock acquisition across cache handles within one process so concurrent live checks do not exhaust the filesystem lock's retries competing with their own writers. Cross-process locking, publication fencing and existing retry limits remain enforced.
- 63e76b2: Keep a live context request's deadline active until the request settles. A noncooperative adapter
  cannot leave an unresolved request when no other socket or timer keeps the process alive. Clear
  owned timers after success, failure or cancellation.
- 63e76b2: Retry explicitly classified native context-observation races up to three times within the existing live-session deadline. Failed observations retire prior evidence, and fresh attempts capture a new publication fence; permission failures and malformed evidence are not retried.
- 63e76b2: Drain pending context cache writes when closing a live analysis session after cancellation. Native context waits remain cancellable, and late native failures cannot publish stale evidence after shutdown.
- 63e76b2: Reacquire and persist live query evidence after cache invalidation or context retirement, including when the newly observed database context has the same identity. Discard scheduler results from the previous evidence generation so refreshed queries remain available after an offline restart.
- 63e76b2: Apply bounded automatic context refresh when a native adapter reports guard drift while observing initial or final context metadata. Fresh attempts share the existing batch deadline and start only after cleanup. Pinned contexts, cancellation, malformed metadata and cleanup failures remain blocking.
- 63e76b2: Preserve retired database contexts across later retirements and cache capacity handling. When individual retirement history exceeds the configured bounds, require fresh context observation for unrecorded scopes instead of allowing old durable evidence to become eligible again.
- 63e76b2: Expose grammar-neutral profiles and collect finite source/SQL-file query candidates before semantic analysis. Share rendering and binding normalization with compilation, preserve nested placeholder indexes and source spans after fragment expansion, and reject explicit structural expressions that remain unrendered instead of treating them as parameters.
- 63e76b2: Retry automatic project-catalog capture for explicitly classified native guard drift and when its base cache evidence is retired before publication. Recapture uses the existing bounded context-drift retries and closes each prior owner before retrying; pinned contexts, unclassified failures and cleanup failures remain blocking.
- 63e76b2: Keep active query views valid when live database observations confirm an unchanged context. Observation timestamps still refresh, while catalog changes, retirement and invalidation retain their publication fences. This avoids spurious unavailable editor diagnostics when context refresh overlaps query preparation.
  
  Require consistent builtin scalar families for DuckDB native expression acquisition. Session-dependent binding results require separate qualification. Advance the adapter/profile revision so previously captured contracts cannot bypass this admission change.
- Updated dependencies [63e76b2]
- Updated dependencies [4de04fc]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [825eba3]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
- Updated dependencies [63e76b2]
  - @typed-sql/core@3.0.0-rc.0
  - @typed-sql/schema@3.0.0-rc.0

## Unreleased

- Introduce content-addressed query contracts and synchronous frozen contract consumption with durable export/import.
