# Query-contract implementation evidence

PR #280 implements query contracts, persistent offline reuse and configured live regeneration.
The architecture target is described in [the specification](./spec.md); it is broader than the
native transport currently qualified by this PR.

## Scope

- Keep the existing offline grammar catalogs and semantics from the base branch.
- Add neutral, bounded contracts, reconciliation, context identities and durable closures.
- Add the disposable `.typed-sql` cache, scheduling, invalidation and cancellation.
- Integrate offline, frozen and live modes with the compiler, CLI and language server.
- Isolate lightweight runtime/profile entrypoints from eager analysis and optional drivers.
- Qualify PostgreSQL expression-query acquisition with independent static reconciliation.
- Add DuckDB builtin expression-query acquisition and reconciliation on both qualified Node SDK engines.
- Add MySQL builtin expression-query acquisition with an owned backup-locked session and independent reconciliation.
- Add SQLite read-only native query acquisition and SQL Server guarded expression acquisition.

The exhaustive upstream inventory, vendor fact extraction, global catalog model, generated
completeness reports and selected-version/core/compatibility-pack APIs are excluded. Normal
builds and installations do not fetch database sources or require a global engine inventory.
The existing PostgreSQL/MySQL catalog generators also derive small runtime codec projections
from their maintained catalog inputs, preserving compile-time/runtime policy agreement.

## Qualification limits

PostgreSQL native acquisition uses the documented guarded SELECT profile; table admission is restricted to checked permanent scalar-column heap tables.
DuckDB native acquisition supports builtin scalar expression projections on 1.5.6 and 2.0.0;
its real-engine tests exercise the shared live runner, persistent cache, offline reuse and conflicts.
DuckDB packed CLI generation, changed-query regeneration and frozen checking pass on both SDKs;
its packaged editor path is also qualified for SQL documents and TypeScript templates.
MySQL acquisition is qualified on 8.4.11 and 9.7.2 for guarded SELECT queries, including
installed CLI/build/editor entrypoints. SQLite acquisition and installed host flows pass on the
qualified Node runtimes. SQL Server acquisition passes on the four pinned engines and ten
compatibility profiles; installed CLI/build/editor flows pass on all four pinned engines.
Build transforms and `typed-sql-build types` consume durable query contracts. Frozen builds avoid
analyzer/native initialization; offline and live-configured builds use offline rules for unrecorded
queries without opening a database. Build inputs exclude the disposable development cache.
Project routine catalog APIs support PostgreSQL fixed scalar declarations, automatic selected
capture/refresh in the CLI and editors, and offline restart from exact SQL-set cache closures.
Other grammar interpreters, custom type/rule qualification, selection merging and workload-selected
offline packs remain incomplete.

## Validation

The reduced implementation passes the full build, typecheck, quality, documentation and performance gates;
138 grammar/init test files; 49 repository/native-type contract files including packed consumers;
and 18 focused contract, cache, reconciliation and codec test files. A real PostgreSQL 18 run
passes non-executing acquisition, connection-loss handling, routine/context drift, editor and CLI
live regeneration, watching, and disconnected packed consumption.

Historical bundle measurements for the excluded catalog pipeline are removed because they do
not describe this implementation.

## Strict project generation evidence

The real PostgreSQL helper also changes a successful built-in result rule after a complete
three-query export. Using the same config identity, database context and cache namespace,
generation and `--check` reject the wrong static claim, persist the conflict and preserve the
durable manifest. Restoring the analyzer succeeds through fresh native reconciliation. This
closes the project-level verification gap for acceptance scenario 20 in the supported expression
profile; broader native engine and statement qualification remains incomplete.

## Selected reusable routine metadata

The neutral project catalog envelope reuses context identities, bounded canonical JSON and
schema validation. Grammar contributions own interpretation and permissions; duplicate owners
or declaration identities fail before analysis. Catalog selection changes the effective profile
identity, and applying metadata recomputes the schema hash and clears stale generator metadata.

PostgreSQL selects complete native overload families by walking project SQL. Its interpreter
recomputes known scalar types from policy, preserves raw parameter/default declarations and
requires nullable outputs. The resolver enforces these permissions before builtin dispatch,
including table-call and builtin-name collision cases. Unqualified calls require explicit
qualification; polymorphic/defaulted/variadic/decimal-dependent/table declarations need exact
query evidence. This is an explicit library path, not automatic CLI catalog generation.

The real PostgreSQL 18 proof captures routine metadata inside a guarded context window and a
read-only snapshot, serializes the selected catalog, and compiles a different SQL statement
without describing that invocation or executing its function. It checks parameter/result
codec plans and a strict function that actually returns NULL for non-null input. Native type
identities now retain their namespaces; display names alone cannot authorize reuse.

Validation for this addition: build and typecheck; analysis and PostgreSQL coverage gates;
repository contracts; packed consumers with project-catalog modules physically absent from the
frozen/runtime path; documentation and quality checks; the real PostgreSQL helper; and the
existing performance budgets. No global source inventory or generated mapping blob is added.

## Native catalog acquisition

The shared native adapter contract has an optional catalog owner and session collection method.
`acquireNativeProjectCatalog` snapshots bounded selectors, observes context without caller
stitching, validates owner/context identity before and after collection, and closes the lease
on success, rejection, cancellation or failure. Unsupported adapters return without connecting.

PostgreSQL collection reuses the introspector's routine mapper and reads only matching system
catalog families. Qualified system functions and operators avoid application overload dispatch;
no user statement or default expression is executed. The native fixture includes shadowing
metadata helper functions and an injected DDL race. This is an explicit library operation;
automatic catalog publication and CLI/editor refresh remain unimplemented.

## DuckDB native query evidence

The explicit Node contract adapter creates an owned instance/connection, opens existing files
read-only, disables external access and extension auto-loading/installing, disables optimizer
evaluation, and prepares inside a read-only transaction. It checks the actual engine version
against its SDK and captures bounded function/type metadata plus settings for the context hash.
Only consistent builtin scalar expression projections are admitted; conflicting routine families, macros,
relations, table functions, aggregates/windows and side-effecting routines remain unqualified.
Descriptors retain decimal dimensions and nested logical shape. No candidate is bound or run,
and absent parameter metadata does not become an inferred input type. Nullability stays unknown.

The grammar contribution distinguishes an unsupported routine-result rule (TSQ408) from invalid
overloads and other errors. Real engine tests resolve json_transform's constant result shape
through native preparation, publish it through the shared persistent live runner, reuse it without
loading the SDK, regenerate changed SQL, reject a deliberately wrong successful offline rule,
persist the conflict and recover after restoring the rule. Separate SDK processes verify 1.5.6
and 2.0.0. An instrumented real SDK rejects execution/binding attempts and checks every native
handle is released when cancellation arrives during preparation. File-backed tests prove routine
DDL changes the context and case-insensitive macro shadowing blocks builtin fallback.
Application-owned instances and files locked by active writers are not qualified by this adapter.

Session-variable binding is excluded. A real-engine regression demonstrates that identical
`getvariable` SQL changes its prepared result type after a connection-local variable is set.
DuckDB 1.5.6 labels this family CONSISTENT, so the grammar rejects it explicitly as well as
rejecting families with non-consistent metadata. Adapter/profile revision v2 invalidates contracts
captured under the earlier admission policy. No candidate values are executed to infer types.

The packed consumer matrix exercises `typed-sql generate --queries --live` and `typed-sql check`
against public package entrypoints on both SDKs. Changing json_transform's constant declaration
from INTEGER to VARCHAR changes the displayed nested field type. Frozen checking then succeeds
with both analyzer loading and native registration configured to throw if initialized. The same
matrix retains the existing runtime, offline build under a writer lock, no-SDK consumption,
provider generation and bundled execution checks. With analysis configuration, the matrix also
generates SQL declarations before and after native contract regeneration, checks them with tsc,
bundles in frozen mode and executes the resulting query with its native nested decoder plan.

The same two-SDK matrix runs the packaged language server in separate child processes with its
stable resolver path (`nativePreview: false`). SQL documents and TypeScript templates acquire a
previously unrecorded BOOLEAN json_transform shape from unsaved text. Two successive unsaved
replacements produce only the current VARCHAR hover. After shutdown, durable contracts are
physically hidden and a fresh offline server reuses the BOOLEAN cache entry while both analyzer
and native factories throw if initialized. Diagnostics and exact nested field types are asserted;
this does not qualify the separate native TypeScript preview integration.

The editor fixture also reobserves a committed catalog change without a document edit. A short
refresh interval exposed context-head churn: observing the same context replaced its revision
and invalidated still-current views. Unchanged usable observations now retain that revision while
updating their timestamp; changed/retired contexts still invalidate tokens and keep publication
fences. Cache and session regressions preserve active views through repeated observations and
retain negative query evidence. The packed matrix passes with 1 ms request-driven observations.
CI runs packed native/editor qualification for each DuckDB engine; the consumer enumerates exact
engine/SDK pairs from the grammar support policy rather than maintaining a separate target list.

The Linux x64 CI and local Darwin arm64 live inventories retain their previous inventory hashes
and recognition counts. Reversing only TSQ408's code/message to the previous TSQ201 fallback
reproduces every previous complete recognition fingerprint for both engines on both platforms.
The reviewed live baselines and shared native findings record this diagnostic-only transition;
no additional invocation is counted as recognized or semantically supported.

## Durable contracts in build hosts

The shared build project path loads a validated durable closure and includes its manifest,
context files and query files in build identities and watcher dependencies. Frozen mode never
loads an analyzer. Offline/live-configured builds prepare source candidates and load the offline
owner only for missing contracts; no schema provider, live factory or development cache is used.
Lazy local owner dependencies participate in source-aware Jest cache keys before cache lookup.
Source preparation and declaration publication check that their config/schema/artifact inputs
remain current. Batch declaration generation shares its guards instead of validating every
source against every other source's guard.

Frozen loading obtains contracts, selected context and dependency paths from one validated
manifest read. Missing or corrupt referenced objects fail rather than being replaced with other
evidence. Explicit query generation may overlay stale build-owned SQL declarations in memory
while checking prospective types. It does not rewrite those declarations or waive application
type errors, and application-owned declarations remain blocking. Ordinary checking still rejects
stale declarations. This removes the generation/declaration cycle exposed by packed consumption.

## MySQL protocol evidence and catalog bounds

The audit adapter preserves independently ordered parameter definitions as well as result
definitions. Real preparation-only checks on 8.4.11 and 9.7.2 retain decimal input/result
differences, unsigned identity and text-versus-binary protocol evidence. The verifier now
interprets these facets without assuming that a cast's result declaration describes its input.
Missing required metadata stays unavailable. Its adapter revision advances to v3.

The broader native audit caught a contradictory resolver bound for two-argument ATAN. Numeric
and string-length families now declare their precise bounds in the maintained catalog input;
the resolver's duplicate bounds are removed. Invalid catalog invocations return unknown with
a diagnostic. Real preparation confirms both one- and two-argument ATAN/ATAN2 forms on the two
qualified LTS patches, including the single-argument ATAN2 form not listed in the manual.

The verifier and audit remain preparation-only metadata checks. Native acquisition uses the
separate consistency guard, binding scope and reconciliation owner described below.

Validation: the full developer E2E flow passes on MySQL 8.4.11 and 9.7.2 under all three maintained
SQL-mode profiles (default, lexical and numeric). Each flow includes native protocol checks,
compiler verification, runtime decoding and reviewed independent language recognition. No live
baseline or native finding is changed to accept the corrected argument bounds.

## MySQL native contract acquisition

The explicit `/mysql2-contracts` adapter owns a fresh connection, holds `LOCK INSTANCE FOR BACKUP`
and starts a read-only transaction before describing builtin expression projections. It never
executes the candidate. Stored functions, loadable functions, table/view references, structural
statements, executable comments and unsupported SQL modes are rejected. Native parameter slots
are checked against the independent tokenizer and retained separately from result metadata.

The adapter checks forbidden routine aliases with the server's system collation, including
accent-equivalent names. Session/engine/catalog evidence binds the contract context; changing
row data or GTID history does not falsely invalidate dictionary identity. Cancellation, initialization,
preparation and cleanup share a bounded lease; late connections are destroyed after cancellation.
The backup lock requires explicit development-database privileges and is never acquired by ordinary
query imports, frozen consumption or the existing verification adapter.

The reconciliation owner rejects contradictory successful offline claims and preserves unknown
or partial identities, nullability bounds and unavailable codec facets. Protocol BIGINT remains
subject to the selected policy; only independently qualified small integer literal projections
receive the core's number rule. VECTOR is qualified on 9.7.2. Geometry execution preserves opaque
bytes in owned mysql2 pools, matching the existing grammar policy.

Direct real-engine proofs pass on both pinned engines: fresh-context identity, decimal parameter
versus result facets, stored routine alias rejection without side effects, DDL exclusion with
ordinary writes allowed, cancellation/deadline lock release, changed-query generation, persistent
offline reuse, static conflicts, geometry contract execution and durable frozen consumption.
The six engine/SQL-mode developer flows pass for this acquisition batch: 8.4.11 and 9.7.2,
each under default, lexical and numeric modes. Each flow includes the acquisition proofs above
alongside compiler verification, runtime decoding and independent language recognition.

Package validation for this adapter passes the clean workspace build, public API/package graph
contracts, quality gate and documentation checks/build. All 28 MySQL test files pass with
96.05% statement, 91.02% branch and 99.09% function coverage. Packed frozen consumers continue
to import runtime/profile modules after every manifest-declared development entrypoint is
physically removed.

## MySQL installed host qualification

A separate packed consumer installs the CLI, build integration, language server and MySQL
grammar from tarballs. It first proves the driver is not a transitive dependency, then explicitly
provides the application's mysql2 driver and bundler. Public live generation records an unknown
builtin invocation; changing the SQL regenerates its durable contract and SQL declaration.
Frozen declaration generation, TypeScript checking and bundling reuse those exports while
analyzer/native factories throw if initialized. The bundled query retains its recorded value
plan and executes through the installed mysql2 adapter.

Installed editor checks cover TypeScript templates and standalone SQL with native preview
disabled. Pull diagnostics and hovers update after unsaved replacements, and request-driven
context observation notices routine-catalog changes without a document edit. After hiding
durable exports and closing the live process, a new offline process reuses the disposable cache
with no connection URI and analyzer/native factories guarded against initialization.

Direct packed proofs and all six maintained engine/SQL-mode E2E flows pass with this same
expanded proof. The complete packed-consumer regression suite, TypeScript project checks,
documentation checks and quality gate also pass after this fixture extension.

## Durable selected catalog closure

A catalog export records its base context, selected catalog metadata and resulting context in
a content-addressed closure. Query-contract manifest version 2 includes that closure in the same
atomic publication; exports without catalogs retain version 1. The target scope identifies base
inputs, while query objects bind to the enriched context. Catalog objects participate in declared
build/watcher dependencies and fail closed when missing, replaced or inconsistent.

Frozen programmatic loading requires independently installed catalog contributions, recomputes
the enriched schema and returns it with the consumer dialect. Stored schema/profile hashes
cannot certify themselves. Changed owners, code output, decoding policy, base scope or metadata
reject consumption. A base schema cannot substitute for the returned enriched compiler input.

The PostgreSQL real-engine helper exercises captured fixed-result routine declarations through
this export/rematerialization path and compiles a different invocation offline without executing
the routine. Neutral tests cover interrupted publication, missing/replaced catalog objects,
forged effective schema hashes, changed owners and exact base/effective identity separation.
Automatic CLI/editor capture and live application remain incomplete; recorded interpreter
registration and host consumption are described below.

Validation of the catalog closure boundary: all 18 analysis test files pass with 98.60%
statement, 93.36% branch and 99.41% function coverage. Build/type checks, public API/package
graph contracts, the complete packed-consumer suite, documentation checks/build, quality and
performance gates pass. The PostgreSQL 18 native helper passes with catalog rematerialization
included. One earlier run observed stale context in the subsequent pre-existing conflict-cache
check; an isolated recheck passed that full flow without changing the guard or its assertion.

## Recorded catalog host consumption

Configurations register `analysis.projectCatalogs.loadContributions` without evaluating it at
registration time. CLI, build and editor hosts invoke it only for selected catalog closures.
Frozen consumers carry the rematerialized schema into compiler calls, SQL declarations and
build transforms; the base snapshot remains an independently checked input. Offline hybrid
checking can use selected declarations for new exact SQL, without invoking native factories.

CLI offline generation preserves the catalog closure and its base target scope. Builds read
only durable inputs and interpreter code, while editor dependency tracking includes immutable
catalog objects and lazily imported local interpreter modules. Offline CLI/editor consumption
checks retirement against the base context and guards its cache token. Context lookup can
report an explicitly retired durable context even when no target head was ever published;
it never promotes that supplied context to usable evidence. Frozen checking ignores the
disposable development cache.

The PostgreSQL native helper now exports an empty query set with selected fixed-result routine
metadata, checks a new invocation through the offline CLI, generates its exact contract offline,
then consumes it frozen. An unsaved different invocation resolves in the editor from the same
selected metadata. Native factories are guarded against initialization, and the routine's side
effect counter remains unchanged. Automatic catalog capture/refresh and live schema application
are still outstanding, as are SQLite/SQL Server native acquisition and broader native statements.

Validation: 18 analysis test files pass with 98.74% statement, 93.47% branch and 99.41%
function coverage; all 11 CLI files, the build suite and all 16 language-server files pass.
The final real PostgreSQL helper, clean workspace build, API/package graph checks, complete
packed-consumer suite, documentation checks/build, quality and isolated performance gates pass.
The packed consumer also creates a sparse contributed catalog after analyzer/catalog modules
and drivers are physically removed, then compiles and checks its exact contract through the
installed frozen CLI. This qualifies the neutral contribution boundary; it does not claim that
every built-in project interpreter is independent of its grammar's semantic catalog.

## Automatic finite catalog capture

`analysis.projectCatalogs.capture` opts explicit live generation into selected metadata capture.
The native service is constructed against the base snapshot and independently configured target.
Guarded catalog acquisition validates the selected owner and both context reads, then installed
contributions derive the schema and profile identity. Query acquisition wraps native context reads
with exact base-context validation before exposing the derived identity; it never configures a
base adapter with the enriched schema or silently drops its changed hashes.

A shared batch deadline bounds capture, pure loaders, native wrappers and service cleanup.
Late factories are disposed. Automatic selection retries bounded context drift only after closing
the previous owner; pinned-context drift, unavailable capabilities, ownership mismatch and cleanup
failures remain blocking. The base observation token and derived query tokens fence publication.
The CLI exports the returned catalog closure through the existing atomic manifest commit.

Hybrid preparation uses independently owned offline rules only when the adapter declines the
statement class. Native-required mode still blocks that case; conflicts, native rejections and
incomplete comparisons cannot use this fallback. This closes a live/offline inconsistency exposed
by a PostgreSQL operator expression supported by offline catalog semantics but excluded by the
restricted native profile. No native statement scope is widened by this change.

The PostgreSQL helper starts without exported catalog objects, automatically captures selected
routine declarations, exports both reconciled native and offline-rule queries, regenerates changed
SQL and refreshes after a catalog-epoch change. Offline and frozen consumers then use the new
closure, with the routine side-effect counter unchanged. Automatic session/editor capture remains
unimplemented: it requires persisted catalog selections in the disposable cache and bounded
session scheduling. The session API explicitly diagnoses that unsupported capture capability.

Validation: all 19 analysis test files pass with 98.66% statement, 93.22% branch and
99.43% function coverage. All 11 CLI files and 16 language-server files pass, along with
packed consumers, API/package graph checks, build/type checks, documentation checks/build,
quality and isolated performance gates. The isolated PostgreSQL helper passes the complete
automatic-capture and existing native/cache/editor/frozen flow. An earlier parallel run returned
stale-context in a later guarded acquisition; the guard and assertion were retained.

## Persisted catalog selections and live sessions

The owned private cache now stores immutable selected catalog closures. Its selection key hashes
the exact SQL set and independently configured base scope; SQL source is not stored in the index.
Publication requires both the selection revision and a usable base-context observation token.
Changed epochs, competing writers and invalidation fence stale producers. Reobserving identical
metadata retains its selection revision. Cache quotas, descriptor-safe object access, immutable
writes and pruning across namespaces apply to these objects as well as query evidence.

Configured live sessions support catalog capture through one shared native owner. A serialized
capture queue bounds aggregate native work; pending requests retain the existing session limits.
Capture uses a 300 ms source-edit debounce and a batch deadline that includes queue wait.
Repeated requests reuse a valid document view within the observation interval. Context changes,
document versions, closure revisions and query evidence fence prior views; close/cancel aborts
obsolete work and closes the shared owner once. Remote observations remain request-driven.

Offline preparation can recover a matching cached closure, rematerialize its schema with
independently installed contributions, then consume derived query evidence without native
factories. It checks the base head and selection tokens throughout interpretation. CLI and editor
hosts carry the resulting schema and lazily track interpreter dependencies. Explicit live CLI
checks can also capture without exporting durable artifacts. Frozen builds remain cache-free.

The PostgreSQL helper additionally removes durable inputs and the private cache, opens the built
language server on an unsaved query, and captures its selected routines. A second editor process
in offline mode recovers that selection with an unreachable database address. Offline CLI checking
then consumes the same selection. Candidate-routine side-effect counters remain unchanged.
Analysis tests cover restart storage, independent target/policy/schema identities, corruption,
symlinks, namespace-aware pruning, quotas, concurrent publication, session refresh, debounce,
cancellation, stalled loaders and offline rematerialization.

Remaining architecture work includes SQLite/SQL Server native acquisition, broader statement and
type/rule qualification, workload-selected offline core/optional packs, and the full acceptance
audit. Cache selections currently match an exact SQL set; combining independently captured sets
for unrelated new SQL requires a separately qualified merge rather than implicit unioning.

Validation: all 20 analysis files pass (98.56% statements, 92.99% branches, 99.45% functions),
as do all 11 CLI and 16 language-server files. Clean workspace build, incremental final type
checks, public API/package graph checks, all three packed-consumer suites, documentation
checks/build, quality and the isolated performance gate pass. The PostgreSQL 18 helper passes
the complete capture, process-restart/offline, existing drift/conflict and frozen-consumer flow.

## SQLite native preparation

SQLite contributes optional `contract-profile`, `node-sqlite-contracts` and `reconciliation`
entrypoints. Driver import and connection construction occur only in a spawned acquisition
process, never in runtime/profile imports. Each lease owns one read-only file connection and
schema snapshot and describes one candidate. Deadlines and aborts kill that process and wait
for exit, including while synchronous native code is running. Graceful close first releases the
database; termination is the bounded cleanup fallback. No application connection or callback
registry is borrowed.

The native authorizer allows selection, reads from qualified ordinary tables/views and built-in
functions from the connection's own inventory. Virtual-table contexts are declined before
candidate compilation can invoke a module. Writes, extension loading, PRAGMAs and transaction
changes are denied. Lexical admission rejects multiple statements, named/numbered bindings and
parameter-layout mismatches. Anonymous binds use the SQLite value domain with the selected
integer policy and the execution adapter's boolean-input normalization.

Schema, engine/source version, compile options, built-in routines and collations bind the native
context. Preparation reads column metadata without stepping the candidate. Declared origin-column
types remain provenance: `SELECT text_column ... UNION ALL SELECT 42` can report the first
column's TEXT declaration while returning integer values too. Result identities remain partial,
runtime values retain the nullable storage-class bound, and flexible-unknown policy remains
unknown. Required complete native identities block. Missing static capability evidence can use
native acceptance. Guarded native preparation can also supply exact-statement syntax absent from
the offline parser, including standalone VALUES and LIKE ESCAPE. Invalid native SQL, static
schema/arity errors and unrenderable dynamic source remain blocking. Reconciliation does
not claim native verification of precise expression types, JSON shape or cardinality.

Native tests cover joins, CTEs, compound results, built-ins, exact anonymous bindings, both integer
policies through actual planned execution, rejected writes/external access/unregistered callbacks,
WAL schema drift, cancelled startup, deadline termination and repeated close. Successful
preparation of a query that would fail with an oversized blob proves the candidate is not
evaluated. The native test file passes on Node 24.10.0/SQLite 3.50.4 and
Node 24.22.2/SQLite 3.53.4. On hosts without authorizer support the profile is unavailable.

The installed-package proof generates/regenerates contracts, executes their decoding plans,
checks unsaved live editor SQL, then deletes the database and private cache and checks frozen
with guarded analyzer/native factories. CI's pinned SQLite job builds and runs the native suite
and packed-consumer proof. SQL Server acquisition, SQLite project-catalog capture, broader
precision qualification, compact offline-core selection and the full acceptance audit remain.

Validation: all 17 SQLite test files pass with 93.87% statement, 87.11% branch and 98.54%
function coverage. The native file passes on both qualified runtime versions. Clean workspace
build and final type checks, installed package/whole-query editor proof, public API/package graph,
documentation checks/build, quality and the isolated performance gate pass. Runtime/profile
distribution checks continue working with optional development exports and semantic catalogs
physically removed. Native children exclude application preloads and module-search overrides.

## SQL Server descriptor foundation

The internal `contract-descriptors` module now preserves independent result and parameter facets
from SQL Server's native description APIs. It records byte widths, precision/scale, collation,
qualified alias/CLR/XML provenance, native ordinals and safe parameter declarations. Missing
dimensions or alias evidence cannot become complete identities. Alias and typed XML identities
remain partial; CLR and opaque representations remain unknown without a qualified codec.
Character parameter identities retain unknown collation while their validated system binding
declarations remain usable. Native nullable results retain an upper bound, while a native
non-null result is exact. Contradictory dimensions, invalid declarations, duplicate labels and
ambiguous slots fail closed. No static claim or application sample enters this conversion.

These rules follow the documented fields of
[parameter description](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-describe-undeclared-parameters-transact-sql)
and [result description](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-describe-first-result-set-transact-sql).
Descriptor tests cover metadata fixtures; they do not qualify a live SQL Server acquisition path.
No native acquisition entrypoint is exposed yet, and the existing verification API is unchanged.

The next layer needs an independently attested exclusive lease, bounded cancellation/discard and
a consistency guard around both metadata operations. A transaction-log quiescence guard is an
option that requires real-engine qualification: Microsoft's
[log statistics API](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-db-log-stats-transact-sql)
exposes the last LSN, with VIEW SERVER STATE before SQL Server 2022 and VIEW SERVER PERFORMANCE
STATE from 2022. Database/recovery-fork identity and schema/session evidence must accompany that
guard; a schema fingerprint alone cannot rule out intervening changes. Broad native statements,
custom bindings and public CLI/editor proofs remain unqualified for SQL Server.

Validation: all 23 SQL Server test files pass (96.33% statements, 91.4% branches,
95.73% functions). The descriptor module has full statement/function coverage. Final workspace
type checks, public API/package graph checks, the installed packed-consumer suite and quality
checks pass. Public exports and application behavior are unchanged by this preparatory module.

## SQL Server guarded acquisition qualification

The private native adapter now owns an exclusive service lease and shares session ownership and
quarantine with the existing verifier. Database/recovery-fork identity, physical connection,
transaction state, session options and transaction-log end position guard context collection and
both description operations. Context identity retains server, principal and bounded catalog
metadata; transient connection and log positions are lease guards rather than cache identities.
Candidate text is bound as data to the native description APIs. Admission currently covers plain
builtin expression projections and canonical parameter slots, without relations, qualified
routines, custom casts, windows or nested statements. The independent reconciler preserves
blocking static errors, compares successful claims, and retains incomplete native facets.

Local tests cover context/settings drift, raw-error redaction, bounded startup and operations,
late acquisition disposal, cancellation, closing active operations, shared service exclusion,
cleanup failures and contradictory static claims. All 24 SQL Server test files and their existing
coverage gate pass; workspace type checks, quality and public API/package graph checks pass.
The real-engine probe is wired into the existing Linux x64 qualification matrix for SQL Server
14–17 and each supported compatibility level. It reads actual connection version/settings and
requires exact fixture builds. The native acquisition step passes on all four engines, with 40
reconciled contracts across ten compatibility profiles; see [the native proof](./sqlserver-native-proof.md).
The adapter, identity and reconciliation modules remain private; public CLI/editor integration
and installed consumer qualification are still outstanding. Local fixtures alone do not establish
native support.

## Retirement history under cache pressure

Retiring an unrelated context previously replaced the entire retirement index. A second process
could then treat an earlier, headless durable context as eligible again. Retirement now preserves
previous stale-context records. If their count or serialized size exceeds the configured bound,
the namespace retains a compact conservative barrier: unobserved contexts require a fresh
observation. A fresh scoped observation can restore that scope while other unobserved scopes
remain blocked. Explicit live query acquisition can still qualify fresh evidence; ordinary
offline lookup does not clear the barrier. Explicit cache invalidation remains a reset operation.

Regression tests reproduce the prior failure and cover consecutive retirements, query-reported
staleness, capacity-limited context publication, restart, pruning, count/byte bounds and recovery
through fresh observation. The existing index format and publication-token contracts are retained.

## SQL Server public integration

Explicit `contract-profile`, `native-contracts`, `odbc-contracts` and `reconciliation` entrypoints
expose native acquisition independently of normal query imports. The ODBC factory owns a fresh
connection per lease and initializes no driver when constructed. Generic pools remain available
through the native adapter. Manifest-declared development exports keep acquisition and comparison
outside ordinary runtime distribution checks. The public profile and its capability limits are
documented in the SQL Server guide.

The packed native fixture uses installed CLI, build, language-server and grammar tarballs. Its
qualification covers a builtin absent from the offline catalog, changed-query generation,
bigint parameter plans, SQL declarations, frozen bundling/execution, unsaved SQL/TypeScript edits,
context drift and an offline cache-only restart. It deletes its owned database and development
cache before a final frozen check/build. This fixture passes on all four pinned native engines
in [run 42519523928](https://github.com/Lojhan/typed-sql/actions/runs/42519523928) at commit
`ab69557c7704635e92c8653cc47d444c2674fdbf`.

Local validation passes the clean build, 24 SQL Server test files and their coverage gate,
public API/package graph checks, the packed-consumer regression suite, quality and documentation
checks/build. The preceding complete native qualification run
[42517605531](https://github.com/Lojhan/typed-sql/actions/runs/42517605531) passes all four jobs,
including the reviewed inventory baselines; that run predates these public integration changes.

The first installed native run reaches a `context-changed` failure during generation. The finite
live host previously retried query-reported drift but propagated classified guard drift from
initial/final observations. Observation now uses the same bounded refresh policy, after cleanup,
within the existing batch deadline. Pinned contexts, cancellation, invalid metadata and cleanup
failures still block. Borrowed catalog views propagate drift to their owning capture so the full
catalog is recaptured after closing its owner. Regression tests cover both observation boundaries,
attempt limits and cleanup ordering. The installed fixture labels generation phases for further
diagnosis. The complete native rerun above passes after this correction.

## Current bundle evidence

The [bundle report](./bundle-size.md) restores the specification's missing measurement links.
A reproducible committed-source tool discovers all five grammars from the ledger, resolves public
exports and reports 30 current source graphs with minified/gzip/Brotli sizes and input attribution.
It remeasures the 20 earlier exhaustive-pipeline scenarios with the same tool. Root tags, profiles
and frozen hosts contain no global grammar catalog inputs. The result distinguishes analyzer
changes from production tags and contract-host overhead; it does not claim representative corpus,
selected-core or schema/plan-growth measurements. A separate fresh tarball installation now
records published dependency payloads for every grammar, with maps/declarations, archive hashes,
package content digests and dependency edges. It excludes optional peers and application-installed
drivers/toolchains, and does not claim total filesystem/store usage or a historical installation
comparison. See the [installation method and limits](./bundle-size.md#published-dependency-payloads).

## Generated SQL-file tree-shaking

A bundler regression confirms that unselected SQL-file modules retained their SQL text and value
plans through barrel exports when the application did not declare `sideEffects: false`. Static
successful initializers now carry purity annotations. Value plans are validated during compilation
before their constructor call can be removed; invalid SQL modules retain their throwing behavior.
The regression executes the selected factory and verifies its bigint parameter and decoding plan,
checks that unused SQL/column markers disappear, and checks invalid metadata fails before emission.

All 20 compiler test files and the existing coverage gate pass, along with workspace type checks.
The clean build, packed-consumer/API/package-boundary checks, documentation checks, quality and
isolated performance gate pass for this addition. Representative corpus and schema/plan-growth
measurements remain incomplete.

## Guarded PostgreSQL table descriptions

The native profile now admits ordinary table projections, stars, comparison/boolean predicates
and joins. Native relation checks run before candidate Parse, with access-share locking and an
identity recheck under the existing WAL guard. Profile/interpreter revisions invalidate the older
acquisition identity. The real-engine proof adds immutable planner traps, no-execution counters,
unsafe relation rejection, lock lifetime, quoted identifiers and serialized frozen compilation.
See the [scope and evidence](./postgres-native-proof.md#guarded-table-query-expansion). Other native
profiles and richer PostgreSQL statement forms still require expansion.

The SQL Server installed-host rerun [42523069734](https://github.com/Lojhan/typed-sql/actions/runs/42523069734)
passes all four engine jobs at f0d92547, including the SQL-file emission changes.

Validation for this expansion: all 37 PostgreSQL files pass with 97.28% statement, 90.30% branch
and 97.99% function coverage. The clean build, quality, documentation and three
public-API/package-graph/packed-consumer files pass. The complete real PostgreSQL 18.3 helper
passes catalog capture, live generation, editor/cache restart, conflict/DDL handling, installed
frozen consumption and the new guarded table cases. An initial run rejected WAL drift during
live catalog generation; the table fixtures now run after the existing host proof, preserving
its isolated catalog context. The adapter's consistency guard and retry limits are unchanged.

Final incremental workspace type checks, clean-tree quality and the isolated performance gate pass.

## Guarded MySQL table descriptions

The native adapter now admits ordinary InnoDB projections, stars, filters and joins in the selected
database with case-sensitive table identifiers. Table/column dictionary records captured under the
backup lock join the context digest. This closes the prior table-DDL invalidation gap without
invalidating contracts for ordinary row writes. Native preparation still rejects views, generated
columns, other engines, stored/loadable routines and unsupported statement forms. Profile/interpreter
revisions require regeneration of earlier artifacts.

The real-engine table helper passes on MySQL 8.4.11 and 9.7.2. It checks independent parameter
types, decimal modifiers, join metadata, unsafe-object rejection, advisory-lock non-execution
while the native session remains open, exact BIGINT decoding after star expansion, separately
reconciled serialized frozen compilation, DML-stable context and DDL blocking/invalidation.
See the [scope, source checks and evidence](./mysql-native-proof.md).

The installed MySQL host fixture now uses real table queries rather than expression-only SQL.
On both 8.4.11 and 9.7.2 it passes CLI generation, frozen SQL-file declarations and TypeScript
checking, bundling/execution, unsaved SQL/TypeScript editor regeneration, separate routine/table
DDL observation and cache-only restart with durable inputs hidden. The complete native helper
also passes on both engines. All 28 MySQL files pass (96.07% statements, 91.08% branches, 99.09%
functions), as do the clean build, workspace type checks, quality, docs and three
public-API/package-graph/packed-consumer files. Other engine profiles, richer statement forms
and the broader architecture's remaining acceptance requirements stay open.

The star regression also exposed a transport mismatch for number-bound literals in a BIGINT wire
family. The optional scalar normalization hook now receives its descriptor. MySQL normalizes
proven integer descriptors under bigint/string policies while core validates safe precision;
portable SQLite wrappers forward the descriptor. Buffered/streamed tests reject overflow and
numeric-looking VARCHAR values and retain unplanned BIGINT policy behavior. Prefix/suffix
projection anchors preserve literal bounds without assigning them to expanded table columns.
Ordinary expression defaults remain admitted despite MySQL's DEFAULT_GENERATED flag.

Final validation after the transport correction: the clean build passes; 24 core files pass
(98.56% statements, 91.44% branches, 97.85% functions), all 28 MySQL files pass (96.08%, 91.08%,
99.09%), and all four portable-adapter files pass. Both rebuilt native/installed MySQL matrices
pass with expression defaults, star reconciliation and actual bigint/string-policy decoding.
All nine soundness files, all three packed-consumer/editor suites, public API/package graph
contracts and documentation checks pass. The native scope still excludes the documented
statement/object forms; this is not completion of the full architecture's acceptance audit.

Final workspace type checks, clean-tree quality and the isolated performance gate pass after these changes.

## Guarded DuckDB table descriptions

The native adapter now admits ordinary stored-table projections, stars, filters and joins.
It snapshots relation definitions, column metadata and current name resolution inside the owned
read-only transaction. Table DDL changes context identity without depending on a caller snapshot
refresh; ordinary DML preserves it. The existing canonical-DDL parser establishes generated-column
evidence on both 1.5.6 and 2.0, avoiding a weaker 1.5 metadata assumption. Views, generated columns,
table functions, star modifiers and unknown logical types remain unavailable. Function-family
qualification now also visits filters and join predicates. Adapter/profile v3 require regeneration.

The real native test passes on both SDKs, including uncast parameter inference from a table
comparison, join/star/decimal metadata, ordinary defaults, ASCII case-insensitive relation binding,
unsafe relation/function rejection, DML stability and DDL invalidation. All 40 DuckDB files pass
with 98.45% statements, 90.67% branches and 97.05% functions. Installed host fixtures now use
joined table queries and test table-DDL editor regeneration; their final validation is pending.

The SQL Server cross-check [42526976076](https://github.com/Lojhan/typed-sql/actions/runs/42526976076)
passes all four engine jobs at d7aefe77, including installed host and shared normalization behavior.

The installed 1.5.6 and 2.0 flows pass joined table-query generation, frozen declarations/build
and execution, SQL/TypeScript editor refresh after table DDL, cache-only restart and offline
operation under a native write lock with and without the SDK. A subsequent real binding probe
found a pre-existing implicit-call gap: a macro named '+' could hide getvariable and change the
bound result from INTEGER to BIGINT without a SQL-text change. The regression fails before the
fix. Admission now checks overlapping operator/constructor/extraction families too, and real
SDK regressions pass on 1.5.6 and 2.0 for '+', array_extract, list_value, struct_pack, row and
struct_extract. The installed rerun after this guard is pending.

DuckDB native qualification now discovers every qualified engine from its owner support policy
and pinned SDK declarations. Normal package tests run additional SDKs in fresh child processes
after the main coverage suite; the standalone test:native command qualifies the full matrix.
The test asserts the loaded engine version and rejects missing/ambiguous declarations, preventing
a newly qualified target from silently escaping the native regression suite. Both discovered
targets pass the table and implicit-binding regressions.

Final DuckDB validation: the rebuilt installed matrix passes on both 1.5.6-r.2 and 2.0.0-r.1
after the implicit-binding guard. Normal package tests pass 40 files with 98.45% statements,
90.64% branches and 97.05% functions, then automatically pass the additional SDK's native suite.
The standalone discovered two-SDK matrix passes, and an intentional failing-test smoke confirms
that its programmatic Poku child exits nonzero. The clean build, public API/package graph,
packed-consumer and documentation gates pass. See the [native scope and evidence](./duckdb-native-proof.md).

Final workspace type checks, clean-tree quality, documentation checks and the isolated performance gate pass.

## SQL Server guarded table descriptions

The v2 native adapter admits schema-qualified ordinary local table projections, stars, filters
and joins. Bound server-side name resolution precedes capability checks; captured table/column
flags and security predicates join context identity. Existing log-quiescence guards remain in
force around resolution and description. Unsupported relations, custom types and implicit
computed/security behavior are rejected. See [scope and qualification evidence](./sqlserver-table-proof.md).

All 24 package test files pass with 96.69% statements, 91.09% branches and 95.78% functions;
workspace type checks pass. [Run 42532051883](https://github.com/Lojhan/typed-sql/actions/runs/42532051883)
passes all four Linux x64 jobs at a30e4d95, including native table contracts and installed hosts.
Downloaded artifacts contain 70 reconciled contracts and 40 unsafe-object rejections across ten
engine/compatibility targets. Clean build, quality, docs, API/package graph, three packed suites
and isolated performance gates pass. Broader architecture acceptance remains outstanding.

## Migration-derived qualification and disconnected builds

The PostgreSQL developer-flow E2E suite now provisions isolated qualification/replay databases,
plans and applies actual file-backed migrations through the public migration engine, introspects
the resulting schema and exports an independently reconciled native query contract. Missing
routines/extensions and changed semantic settings reject the previous context even when the
table remains. An unqualified pgcrypto installation is explicitly rejected by native acquisition;
its routine metadata is still introspectable. No extension admission policy was weakened.

Both fixture databases are dropped before a separate packed installation consumes the durable
inputs. The shared frozen-consumer proof removes analysis/catalog/native modules and excludes
the pg driver, installs Node connection/DNS/fetch traps, checks compatible/incompatible downstream
types, bundles through the public esbuild integration and inspects the generated query's value
plan. Missing durable evidence remains an explicit failure. This proves scenario 21 for the
qualified PostgreSQL profile, not every grammar/extension combination or an OS network namespace.

The real flow exposed an introspection bug: PostgreSQL uses empty proargnames entries for unnamed
parameters alongside named outputs. The shared routine codec now omits that absent name while
preserving slots, modes and output labels. The provider regression fails before the fix and
passes afterward; real pgcrypto metadata now introspects successfully.

After the clean rebuild, the new migration/frozen flow and existing full PostgreSQL native/host
proof pass on 18.3. All 37 PostgreSQL files and coverage, workspace types, nine soundness files,
API/package graph, three packed suites and docs pass. See the
[detailed scope and evidence](./migration-qualification-proof.md). Representative corpus
measurements, reusable catalogs/packs and the full architecture acceptance remain outstanding.
Final clean-tree quality and isolated performance checks pass.

## Project growth measurements and template tree shaking

The [commerce project report](./project-size.md) and [machine-readable measurements](./project-measurements.json)
now cover every grammar discovered from the feature ledger at 4f19d947. They reuse the maintained
commerce DDL and queries, export/reopen actual offline-rule contracts, measure minified/gzip/Brotli
runtime graphs and named artifact closures, and separate the base workload from 10/50-copy
exact-text stress cases and 50/500 extra product-shaped schema relations. The public-entry
baseline scenarios are rerun at the same revision against the original exhaustive-catalog ref.
These are curated examples and partial model snapshots, not production usage or native evidence.

The first run exposed an actual template metadata leak through barrels: unused static plans and
conditional/repeated selectors retained their constructor calls. The compiler now validates their
static data before emitting pure initializer annotations. A new bundled-consumer regression fails
before the fix and passes afterward, retains observable application initialization and rejects
invalid descriptors during compilation. All 21 compiler files pass with 96.87% statements,
91.15% branches and 99.58% functions; workspace types and clean build pass.

The selected-module graph retains exactly one application module and the same minified byte count at 1, 10 and
50 copies for every grammar (18,559–19,113 minified bytes). Retaining the full base example's
template modules adds about 1.9–2.2 KiB gzip for runtime plans. At 50 copies the actual exported
offline closures contain 350/400 exact contracts and 539–704 KB of file contents; their framed
gzip sizes are 47–58 KB. No schema, durable envelope or global analysis catalog enters those
runtime bundles. Unknown codec descriptors remain visible rather than counting as full support.

[Run 42535227376](https://github.com/Lojhan/typed-sql/actions/runs/42535227376) passes all four
SQL Server jobs at compiler commit 57e35256, including the installed native/table/editor/frozen
flows. The PostgreSQL migration-derived isolated frozen build passes with the new compiler.
Build adapter, CLI, language-server, bridge, nine soundness files and docs pass. Public API/package
graph, all three packed-consumer/editor suites, clean-tree quality and the isolated performance
gate pass. An independent report check verifies five workload rows, 15 scaling cases, 15 schema
cases and 50 before/current public-entry graphs. Native-qualified project payload/latency,
production workload selection, reusable catalogs/packs and the full acceptance audit remain open.

## Workload codec regression gate

The follow-up measurement at 6cfc77d8 has known runtime codecs for all 37 finite commerce
candidates: PostgreSQL/MySQL/SQLite 7 each and SQL Server/DuckDB 8 each. PostgreSQL declaration
metadata supplies enum descriptors; MySQL normalizes JSON type spellings before parameter
classification; SQLite carries its known numeric runtime family through derived/compound output
and parameter contexts. Runtime-sized fragments remain compiled but are excluded from finite
exact-contract counts. Known JSON codecs do not imply known document shapes.

The normal contract suite now discovers supported grammars from the feature ledger, selects their
maintained commerce files and rejects unresolved codecs recursively, without a function-name list.
Reverting only the three resolvers makes that gate reject each of the previously measured gaps;
the current source passes. This is a workload regression gate, not a universal SQL coverage claim.

MySQL compiled JSON execution passes on 8.4.11/9.7.2 under all three JSON policies. SQLite 3.53.4
execution covers integer/REAL sums, empty aggregates, CTE predicates, compounds and numeric casts
under bigint/number policies. The full 28-file MySQL and 17-file SQLite coverage gates, clean
build/types, soundness, packed consumers/editors, docs, quality and isolated performance checks
pass. See the [MySQL proof](./mysql-native-proof.md), [SQLite proof](./sqlite-codec-proof.md) and
[project report](./project-size.md). Full architecture acceptance remains incomplete.

## Tracked source and data accounting

The [repository ownership/topology report](./repository-size.md) measures source at 21856214
against the PR base and the exact +486,674 / −67,823 proposal. The tool reads Git blobs, separates
header-declared generated code from maintained code and captured data, and reproduces all three
independent Git line deltas. Five vendor fact catalogs (175,882 lines) and the separate 165,165-line
upstream registry are absent; required native/reference audit fixtures remain. Relative to the PR
base, maintained package source adds 13,487 lines, generated package source adds 659 and tests/E2E
add 17,679. These are physical lines, not production bundle sizes or final core/pack projections.

CI run 42541625378 completes with 41 successful jobs, including the source-quality lane, all
SQLite matrix/audit targets and the repaired DuckDB packed launcher. The required aggregate fails
on the PostgreSQL 18.6 migration fixture's extension namespace assumption; its exact role/name
reproduction and full disconnected-consumer helper pass after the fixture correction. The next
remote run must verify that fix. The unqualified MySQL canary is advisory and still rejects native
acquisition outside the owner profile. This does not establish final architecture acceptance.
