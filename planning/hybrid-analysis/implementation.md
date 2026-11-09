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

The exhaustive routine inventory, giant vendor corpus, global catalog model and generated
semantic-completeness claims remain excluded. Compact pinned keyword extraction is distinct
from that removed pipeline. DuckDB has exact-engine full analyzers, a maintained
bounded core and explicit compatibility packs. MySQL has selected-series analyzers and a core
retaining all of its existing maintained families. All five cores have explicit distribution boundaries and pinned measurements. Representative
workload selection remains limited to the maintained commerce corpus and declared native fixtures. Normal
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
comparison. See the [installation method and limits](./bundle-size.md#published-installation-payload).

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

## Version-isolated DuckDB analyzers

At `2eae5c03`, explicit `analysis/1.5.6` and `analysis/2.0.0` exports select one engine's
existing signatures, casts and common-type matrices through a grammar-owned immutable provider.
The resolver and matching code receive that provider rather than importing the compatibility
registry. The default analyzer still supports both engines. Shared mechanics reuse the light
profile; neither entrypoint loads an optional native SDK. Snapshot validation and analysis both
refuse a mismatched engine instead of selecting another catalog silently.

The tests discover qualified engines from owner policy and compare full selected/compatibility
outcomes for every unique invocation candidate generated from the independently captured native
inventory, including diagnostics, parameters and result metadata. This is distribution parity,
not an assertion that all candidates are valid or supported. Structural expressions, compounds,
lists and CTE parameters also match. Graph tests exclude the other engine's data and compatibility
registry. Replacing the selected entrypoints with compatibility aliases fails both the isolation
and wrong-snapshot tests. Packed consumers import every discovered installed per-version export.

The inventory sweep exposed a prior bare polymorphic MAP-result crash. Missing child evidence
now remains unresolved; the regression checks both engines. No native acceptance is widened.
Both fresh local native audits pass the existing reviewed fingerprints without baseline updates.

Validation: all 41 DuckDB test files and their coverage gate, the additional 1.5.6 SDK's native
suite, clean build/types, packed/public API/package-boundary tests, soundness, docs, quality and
isolated performance pass. Bundle measurements at `6edcd6ed` retain 359.4/384.4 KiB minified for
selected 1.5.6/2.0.0, versus 627.1 KiB for the two-engine analyzer. Runtime tags are unchanged.
The measurement tool now counts native `Generated from` headers as generated attribution on
both baseline and current sources. See [bundle measurements](./bundle-size.md).

CI at `167772ac` passes the required PostgreSQL, MySQL, SQLite, DuckDB and SQL Server native
jobs. Its source-quality lane exposes a PID-file publication race in the cancellation fixture:
an empty file is interpreted as PID 0, so the subsequent liveness assertion checks the process
group. A targeted 80-iteration reproduction observes 78 empty reads. Commit `f26a1b43` publishes
both compiler and CLI fixture PIDs atomically and accepts only positive safe integers; it also
installs the CLI fixture's signal handler before publishing readiness. Both focused fixture tests
and all 21 compiler files with coverage pass. Production cancellation behavior is unchanged.

Workload-selected compact cores, optional semantic packs in all grammars, reusable custom-type
qualification, native-qualified project overhead and the complete acceptance audit remain open.

## Bounded DuckDB core and complementary packs

Commit `1adfc8e5` adds `analysis/core/1.5.6` and `analysis/core/2.0.0` plus explicit installed
compatibility packs. A small maintained family policy selects names; generation retains their
complete existing overload families and all operators, along with shared casts/type combinations.
The optional partition contains the remaining rows. The compatibility catalog assembles those
disjoint partitions in original order. All native signature/cast payloads and snapshot SHA-256s
match the pre-partition files exactly: 819+1,817=2,636 on 1.5.6; 832+2,053=2,885 on 2.0.0.
No second exhaustive vendor catalog is introduced. The generated line increase contains binding
vocabulary, selection/provenance metadata and module boundaries; moved rows increase Git's
added/deleted counts. This is an initial maintained core, not a measured popularity ranking.

The resolver checks core selection before executing a handwritten result rule. Omitted routines
produce an actionable TSQ408; argument analysis still preserves casts and parameter positions.
Removing this check makes the regression incorrectly accept excluded `isfinite`. The first
native regression also rejects the implementation that drops those input parameters as a
static/native conflict. The corrected core obtains parameterized `md5` input/result evidence
through the normal native runner on both engines, without an offline pack or application values.
The native contract retains the string codec, ordered input tuple and conservative nullability.

Pack identity is owned by installed grammar modules. Cloned descriptors, duplicate packs and
other-engine packs fail before analysis. Packs supply complementary rows and share the core's
cast/type mechanics. Independent native-inventory candidates compare core results for selected
names, and all full compatibility outcomes after adding the pack. Structural, parameterized,
CTE, compound and list cases also match. Core import graphs contain no full registry, optional
signature partition, other engine or native SDK. Installed packed consumers load each public
core/pack path discovered from owner policy. Query-candidate generation is isolated in a pure
shared audit module so package test typechecking does not pull the live audit's Node tooling.

Validation: clean build; package test typechecking; all 42 DuckDB files and coverage
(98.88% statements, 91.22% branches, 97.81% functions); additional 1.5.6 SDK qualification;
both native catalog checks; fresh reviewed live audits on both engines without baseline changes;
48 repository contract files plus the corrected documentation contract; soundness; docs check/build;
quality; and isolated performance pass. The full repository run's single documentation failure
was an abbreviated public entrypoint in a table; listing both full import paths fixes it.

The refreshed [bundle report](./bundle-size.md) pins `1adfc8e5`: core is 234.3/246.0 KiB minified,
versus 360.0/385.0 KiB for matching full per-engine analyzers. Composing a compatibility pack has
measured selection/wrapper overhead, which is reported separately. Runtime tags and frozen hosts
remain unchanged and catalog-free. The [repository report](./repository-size.md) now pins the
same revision, distinguishes moved/generated/maintained lines and reproduces the Git line delta.
Final topology, other grammars' core/pack boundaries and representative production workloads
remain incomplete. The preceding `203d573e` passes CI, native language audit and migration
workflows; the new core/pack head requires its own final CI result.

## MySQL selected-series core and native long tail

At `c9e4a793`, MySQL full and core entrypoints explicitly select 8.4, 9.7 or the existing 26.7
canary policy. The resolver and numeric rules receive an immutable catalog owner; the portable
factory imports neither the all-series registry nor introspection services. Existing compatibility
helpers and internal consumers retain their default behavior through a small wrapper. Series
selection rejects missing/mismatched snapshot evidence and preserves SQL-mode, edition and
version guards. Shared compact runtime codec/type facts and availability vocabulary remain.

All existing MySQL routine families fit this core. A measured subset/compatibility-pack prototype
was larger than the full per-series analyzer, so the final source keeps the existing families and
removes that extra machinery. The general analyzer remains compatible. The core gives unmapped
routines a TSQ408 error with generation guidance, retaining argument casts and ordered parameters;
version and ambiguity errors remain blocking. The reconciler's v2 owner permits only that specific
unsupported-rule diagnostic to be supplied by qualified native evidence. Recursive CTE probes
retain the core diagnostic mode. No universal function rule is generated from one invocation.

Tests discover stable/canary targets from owner policy and walk their independent invocation
inventories. Every existing rule agrees with compatibility analysis; unmapped calls retain their
input evidence and request a contract. Core module graphs exclude other full catalogs, the registry,
introspection and drivers. Packed consumers import every installed path and refuse missing target
evidence. All three original full catalogs retain their exact content, order and revision hashes;
the runtime codec projection is unchanged. No source-vendor inventory is added.

The native helper qualifies both constant and parameterized `DEGREES`, an actually unmapped
routine, on MySQL 8.4.11 and 9.7.2. Native preparation reports number output, explicit non-null
metadata for the constant form, nullable output for a nullable parameter, and decimal(65,30)
string input for the cast form. The full native helper retains conflict, cancellation, context
retirement, table and non-execution checks. The installed CLI/build/editor/cache/offline helper
now loads the selected core, proving generation and unsaved/editor refresh through this path.

Validation: clean build/types, 29 package files and coverage (96.25% statements, 91.44% branches,
99.13% functions), all 49 repository contract files, both real native/installed flows, soundness,
documentation check/build, quality and isolated performance pass. The preceding `fdc0fab8` main
CI completes successfully; this new source requires its own final CI result.

Local inventory captures retain every existing default-profile category fingerprint. Their exact
local recognition/context fingerprints require review and were not accepted as new baselines.
An independent Git-blob build of the preceding `fdc0fab8` analyzer and the final compatibility
analyzer produce identical full analysis for all 2,574/2,592 generated invocations under the same
live contexts. This proves the refactor does not change those static outcomes; it does not claim
that the local context is interchangeable with the reviewed CI fixture.

The [current bundle report](./bundle-size.md) pins `c9e4a793`: full MySQL is 185.4 KiB minified,
while selected full/core analyzers are 163.1–163.8 KiB. Gzip savings are small and reported directly.
Runtime/frozen graphs are unchanged. PostgreSQL, SQLite and SQL Server distribution decisions,
reusable catalogs/custom-type qualification beyond PostgreSQL, native-qualified project overhead,
representative workload selection and the full acceptance audit remain open.

## PostgreSQL catalog ownership foundation

PostgreSQL catalog lookup mechanics now take an explicit immutable catalog owner, separate from
its compatibility registry. Each owner copies and deeply freezes its supplied catalogs, rejects
duplicate majors and requires an explicit fallback major. Existing helpers retain their previous
fallback behavior. Selected-version analysis must validate snapshot evidence before invoking these
mechanics; this foundation does not yet expose a selected-major analyzer.

Type/coercion/operator resolution receives that owner through a factory. Candidate, resolution and
upgraded-snapshot caches belong to the factory rather than a process-wide default. Extension
resolution and introspection likewise receive the owner for built-in cast collision checks. Small
compatibility wrappers preserve the existing public analysis/extension APIs and default resolver
behavior. The portable mechanics import no all-major registry, generated catalogs or drivers.
All six original generated catalogs remain unchanged; existing code is moved rather than copied
into a second semantic implementation.

Tests discover supported stable/canary majors and compare every catalog type/alias, cast/context,
operator and routine family with the compatibility registry. Conflicting owners exercise both
schema-free and shared-snapshot operator caches and coercions; extension cast collision checks use
the supplied owner. Input mutation, nested freezing, explicit fallback, server-evidence precedence
and dependency graphs are checked. Resolver/project-catalog injection and public per-major
entrypoints remain outstanding, so this is not a claim of PostgreSQL core bundle savings.

Validation passes a clean build/types, all 39 PostgreSQL files with coverage (97.30% statements,
90.49% branches, 98.02% functions), all 49 repository contract files, nine soundness files,
quality and isolated performance. The complete PostgreSQL 18.3 native helper also passes live
editor regeneration, routine drift, durable/cache offline reuse, frozen consumers, guarded table
qualification and candidate non-execution. The preceding `98f78e06` main CI completes
successfully; this new internal boundary requires its own CI result.

## PostgreSQL selected-major core and native long tail

PostgreSQL full and core entrypoints select majors 14–19 explicitly. The portable factory injects
one catalog owner and its type resolver throughout query resolution, extension resolution and
fixed project-routine admission. Compatibility wrappers preserve existing eager analysis and
internal resolver callers. Selected analyzers reject missing/mismatched major evidence before
resolution; existing stable/canary capability policy remains unchanged. All six generated catalogs
retain their contents and revisions. All maintained routine, operator, type, coercion and JSON
rules remain available in core; no additional PostgreSQL compatibility pack is introduced.

The core's final unknown-function fallback requests qualified exact-query evidence with TSQ408,
retaining ordered argument metadata. Other diagnostics retain their behavior. The reconciliation
v2 owner admits only TSQ408 among errors as unsupported; other errors remain blocking. Native
preparation of one invocation does not create a universal function rule.

Automatic tests discover all stable/canary majors and exercise 23,634 independently captured
name/arity invocations (3,666 / 3,732 / 3,882 / 4,026 / 4,134 / 4,194 for majors 14–19). Selected
full analysis matches compatibility results. Core preserves existing supported outcomes and
argument/column evidence for omitted routines. Packed consumers import every installed selected
path without a driver. Module graphs retain one major's catalog and exclude the compatibility
registry, default type/extension wrappers and introspection services. These are static invocation
checks, not fresh execution of every overload on all six server majors or popularity evidence.

The PostgreSQL 18.3 native helper describes actually unmapped pg_catalog.md5($1::text), qualifies
known string input/output and conservatively nullable output, and runs installed CLI/editor,
project-catalog capture, live refresh, offline/cache reuse and frozen-consumer flows through the
18 core. Its base snapshot now records the actual server evidence required by selected analysis.

Real validation exposed two catalog-capture retry gaps: classified guard drift thrown during
collection was not converted into bounded recapture, and retired base cache tokens raised a
terminal generic error. Both paths now use the existing context-drift retry boundary after owned
cleanup. Deterministic tests retire actual cache evidence before publication and inject collection
guard failures. Automatic recapture closes prior owners; repeated retirement stops after three
attempts. Pinned contexts, unclassified errors and combined acquisition/cleanup failures remain
blocking. No guard or performance budget is relaxed.

Validation passes the clean build/types, 40 PostgreSQL files and coverage (97.36% statements,
90.97% branches, 97.96% functions), 20 analysis files and coverage (98.57% statements, 93.15%
branches, 99.46% functions), all 49 repository contracts, nine soundness files, documentation
check/build, quality and isolated performance. The complete real PostgreSQL 18.3 helper passes
with the final core and recapture code. Local editor.schemaChurn p99 is 4.36 ms against the
unchanged 120 ms budget. This does not replace hosted-runner performance evidence: preceding
`dcddfb4b` CI failed its PostgreSQL collection guard and editor.schemaChurn p99 (156.75 ms).
The collection failure now has a deterministic retry regression; the new source still needs its
own green CI and hosted performance result. Remaining distribution decisions cover SQLite and
SQL Server, alongside representative workloads, native-qualified payload/latency, broader reusable
catalog/custom-type qualification and the complete architecture acceptance audit.

The bundle and repository tools now both pin `1214270f`. PostgreSQL all-major analysis measures
387.3 KiB minified / 68.6 KiB gzip; selected full/core imports measure 274.1–274.5 / 66.7 KiB.
This saves about 29% minified but 2.7% gzip. Runtime/profile/frozen rows are byte-identical to the
preceding report. Tracked generated package source is 26,156 lines (+2,717 versus the PR base),
maintained package source 106,290 (+14,346), and maintained tests/E2E 107,186 (+18,833). The
exhaustive vendor catalog JSON and upstream registry remain absent. Category/package totals and
all three Git physical-line comparisons independently agree; these are measured current costs,
not estimates of the unfinished final architecture.

## SQLite and SQL Server maintained offline cores

SQLite and SQL Server expose portable `analysis/core` factories without eager introspection or
native service imports. Both already have one small maintained catalog with explicit version,
compile-option or compatibility-level gates. Core retains that catalog and every maintained
rule rather than duplicating per-version data or creating additional compatibility packs.
Existing analysis/browser imports preserve their diagnostic mode. Core's unmapped scalar calls
produce TSQ408 with qualified-generation guidance and retain ordered argument evidence. SQLite
CTE probes forward the diagnostic mode. Reconciliation v2 owners admit the new diagnostic while
preserving their existing, separately qualified syntax/capability exceptions.

Shared grammar-neutral test mechanics discover invocation names/arities from independent audit
fixtures rather than another declared function list. SQLite exercises 2,436 invocations across
live/reference inventories at supported-range endpoints, with additional compile-option, version,
arity and CTE checks. SQL Server exercises 16,722 reference invocations across all ten supported
engine/compatibility profiles. These are static comparisons, not execution of every overload or
production-popularity evidence. Core graphs retain parser/resolver/catalog mechanics and exclude
introspection, native acquisition and application drivers. Packed consumers import both paths
without drivers. The installed SQLite CLI/editor/live/cache/frozen consumer now loads core.

The SQLite 3.53.4 native proof describes unmapped subtype(CAST(? AS TEXT)) without evaluation.
It retains the native nullable storage-class domain and incomplete logical type identity; requiring
precise native-type evidence remains incomplete. Generation does not invent an integer return
rule from this invocation. SQL Server native probes and installed-host fixtures now load core;
local unit/inventory checks do not replace the required Linux x64 real-engine matrix.

The expanded SQL Server inventory found a pre-existing crash on IIF() with no arguments. Invalid
built-in arities now diagnose, resolve supplied argument evidence and return unknown before a
semantic rule can read missing arguments. Regression assertions cover unknown row type, ordered
boolean input metadata, placeholder spans and the arity diagnostic span.

Validation passes clean build/types, all 18 SQLite files (94.20% statements, 88.16% branches,
98.56% functions), all 25 SQL Server files (96.91% statements, 91.71% branches, 95.83% functions),
all 49 repository contract files including the installed SQLite flow, nine soundness files,
documentation check/build, quality and isolated performance. Preceding `a80effcc` main CI succeeds,
including hosted performance and the repaired PostgreSQL capture path. The new core source still
requires its own hosted matrix qualification. Representative workloads, native-qualified project
payload/latency, reusable catalog/custom-type scope and the full acceptance audit remain open.

Both measurement reports now pin `191acf45`. SQLite default/core analysis is 148.8 KiB minified /
39.6 KiB gzip, and SQL Server default/core is 121.4 / 34.7 KiB. There is no claimed core size
reduction for these already-small catalogs. Runtime/profile/frozen consumer rows are byte-identical
to the preceding report. The two grammar changes add 60 net maintained package lines and no
generated package lines; shared semantic bodies move behind factories. Current repository counts
separate maintained package source (106,350 lines), generated package source (26,156), maintained
tests/E2E (107,443), captured data and reports. All category/package totals and exact-reference
Git line comparisons agree. No exhaustive vendor inventory is restored.

## Acceptance ledger, current installation payloads and SQL Server baseline review

The [acceptance ledger](./acceptance-audit.md) now maps all 22 required scenarios to inspected
assertions, their qualified boundaries and concrete missing checks. It leaves explicit cold-core
network denial, file-move composition, inherited grammar extension, vocabulary-to-parser
verification and native project cost measurements open. Existing nearby fixtures are not counted
as proof of those combined requirements. The specification's scope note now reflects all five
core entrypoints without removing any acceptance requirement.

Fresh isolated offline package installation at `3f4defff` measures current tarballs and their
published dependency closures independently of bundle graphs. The table includes grammar plus
mandatory dependencies once per package version, declarations/maps, and separate compiler/contract
closure costs; it excludes stores, filesystem blocks, optional peers and application drivers.
Grammar closure payloads are 6.49 MiB PostgreSQL, 2.50 MySQL, 2.24 SQLite, 2.47 SQL Server and
3.59 DuckDB. This is a current after-result, not an inferred compressed-bundle saving.

CI `42557443067` passes source quality/performance and all SQL Server core/native and installed
paths, but its aggregate fails reviewed catalog fingerprints. The [narrow baseline
review](./sqlserver-core-baseline-review.md) proves that all 14 captures / ten compatibility targets
change only the result columns of already-diagnosed GROUPING_ID(). Restoring those columns
reproduces each entire previous observation fingerprint. Categories, native metadata, diagnostics,
parameters and coverage counts are unchanged. Eight adversarial mutations, including changed result labels/spans, are rejected by the new
read-only comparison tool. The ten corresponding baseline/finding fingerprints are reviewed and
updated; no recognition coverage is added. A regression keeps the diagnosed row unknown/nullable.
All 70 native qualified contracts and 40 unsafe relation rejections pass across exact engines
14.0.3560.2, 15.0.4500.2, 16.0.4305.5 and 17.0.5035.5. A fresh aggregate run remains required.

The updated SQL Server 25-file coverage suite, workspace types, language audit check and its
contract test pass. Quality passes with the existing warnings. Runtime source and performance
budgets are unchanged, so the successful hosted performance result is retained as evidence rather
than repeating a noisy timing measurement for data/test/documentation changes.


### Cold offline core consumers

Main CI `42559412931` at `85d25465` passes after the conservative SQL Server
observation review. A new installed-consumer regression discovers the five grammars and their
matching published core exports, compiles a fresh two-parameter COALESCE/CAST query and runs
each offline CLI in a separate process. No application driver, durable contract or analysis cache
is present. TCP/DNS/fetch APIs are denied before compiler/config/core imports, and explicit
probes verify the guard. Config-loader Unix-socket probes are also denied, accounted separately
as IPC, and never establish a connection. This proves a Node-process boundary, not OS isolation.
The fixture checks known nullable results, grammar identity, ordered bindings and no cache
creation. The existing frozen-consumer guard shares the same preload generator.

The final packed-consumer run and workspace typecheck pass locally; formatting/lint checks on
the four changed test files pass. Production package code and generated catalogs are unchanged.


### Source moves and inherited grammar evidence

The real PostgreSQL 18.3 helper now physically moves query source into another directory and
adds leading lines. Re-extraction preserves SQL and ordered bindings; a reopened cache retains
the same qualified contract digest and unverified freshness. Export/reload and offline compilation
retain row, parameter and decoder plans without a native adapter. Query spans and missing-contract
diagnostics follow the shifted source. This proves source-independent evidence and refreshed spans;
it does not claim arbitrary editor filesystem watcher behavior.

A test contribution built only from published base-grammar/core/schema/analysis entrypoints
inherits PostgreSQL 18 mechanics under a distinct grammar, snapshot, profile and interpreter
identity. It delegates native statement restrictions and reconciliation while requiring explicit
child ownership for reusable catalog permissions. The real helper acquires/reconciles a long-tail
query, reopens its persisted cache, exports/reloads a durable closure, compiles offline and checks
the child runtime decoder. Unknown native nullability remains nullable; base/child identities do
not share contracts. The surrounding routine counter proves generation never executes it.

The full PostgreSQL native/installed CLI/editor/cache/frozen/table helper passes. Its conflict
fixture now selects the current recorded project context after a live refresh: legitimate catalog
drift may retire an older context, which must not be mistaken for the new conflict entry. Restoring
the correct analyzer generates fresh reconciled contracts, including any newly observed context;
a conflict still cannot overwrite the previous durable export. Workspace types, all 21 analysis
test files (98.57% statements, 93.10% branches, 99.46% functions), all 49 repository contract files (including packed consumers and editor
artifacts), documentation checks and quality pass. Production package source and generated catalogs are unchanged.


### Selected-core commerce measurements

The project tool now discovers public core exports and selects exactly one using each maintained
example snapshot's version evidence. All compiler output and offline-rule artifacts are generated
through that core. The unmodified finite candidates are separately analyzed with the compatibility
analyzer, with full analysis equality and both diagnostic lists recorded per digest. At source
`1a3785d5`, all 37 candidates match: PostgreSQL 18 (7), MySQL 9.7.0 (7), SQLite 3.54.1 (7),
SQL Server 17 (8) and DuckDB 2.0.0 (8). These are recorded example profiles, not actual server
observations or a usage ranking. All TS modules compile; unbounded runtime-sized inserts remain
excluded from exact contracts. No finite example candidate requires first-use native generation.

The tool exports/reopens all closures and repeats the 1/10/50 identity-growth and 50/500 schema
growth experiments. Every workload, schema and runtime bundle measurement is identical to the
preceding generic-analyzer report. Native-qualified artifact overhead and acquisition/context/cache
latencies remain separate unfinished measurements.


### Partial evidence composition and native cost instrumentation

One composed PostgreSQL project-catalog regression now carries a selected fixed-scalar routine
through the 18 core in a subquery, CTE and compound. A controlled protocol fixture supplies
independent runtime facts, partial numeric identity and unknown nullability. Acquisition,
reconciliation, canonical contract reload, manifest serialization, candidate extraction and
verification retain those limitations together. Exact native-type requirements remain incomplete,
while contradictions in known type facts still produce mismatches. Frozen contracts keep unknown
execution effects; explicit verification can separately use the already-computed core operation
without treating a native description as execution-effect evidence. This is a pipeline regression
using a protocol fixture; native adapter admission boundaries remain declared per engine. All 40
PostgreSQL test files pass coverage (97.36% statements, 91.00% branches, 97.96% functions).

An opt-in measurement helper now attaches to existing owner-qualified native fixtures for all
five grammars. With `TYPED_SQL_NATIVE_COSTS_DIRECTORY` configured, it records three actual
context/acquisition/reconciliation observations, serialized evidence/plan/contract bytes, exported
one-query closure and cache file contents, durable reloads, and reopened/warm cache lookups.
Stale attempts are retained; every reported sample must independently qualify and every recorded
cache read remains unverified. Reports exclude candidate SQL and application values, record the
engine/tool/source/environment identities, publish atomically and remove their owned temporaries.
An older report is removed before a fresh observation so a failed attempt cannot look current.

The normal test path leaves these extra round trips disabled. SQL Server's explicit hosted
native-contract qualification enables them and includes the reports in its existing transport
artifacts for all ten compatibility targets. Initial SQLite 3.53.4 and DuckDB 2.0.0 enabled runs
pass; the final committed helper still needs the complete measured profile collection. These
small owner fixtures do not establish workload popularity or latency guarantees. Cold cache
means a new cache object reading existing files, not a dropped OS page cache or cold server.

Main CI `42562791948` at `4fe65a4f` completes successfully. The new composition/instrumentation
changes also pass workspace types, all 49 repository contracts, docs and quality locally. The
measurement helper separately counts the fixture schema input and asserts its digest matches the
qualified context; that small input is not presented as a full application/server catalog.


### Native cost observations across all five grammars

The [native cost report](./native-costs.md) and [raw observations](./native-measurements.json)
now cover 16 actual profiles, with three independently qualified acquisitions each. Local Node
24.22.2 Darwin arm64 runs cover PostgreSQL 18.3, MySQL 8.4.11/9.7.2, SQLite 3.53.4 and DuckDB
1.5.6/2.0.0. The local owner fixtures ran concurrently; PostgreSQL/MySQL use Podman-forwarded
connections and DuckDB SDKs stay in separate processes. All six complete native helpers pass.

Hosted [CI `42564033389`](https://github.com/Lojhan/typed-sql/actions/runs/42564033389) supplies
SQL Server 14.0.3560.2, 15.0.4500.2, 16.0.4305.5 and 17.0.5035.5 at all ten declared compatibility
targets on Node 24.22.2 Linux x64. All four native transport jobs pass, including 70 qualified
contracts, 40 unsafe-relation rejections and the cost observations. Transport artifact IDs are
13650995622 (14), 13650980752 (15), 13651140626 (16) and 13650173700 (17). The checked-out
merge commit is `12f93112ca31725c5f8a2698f30f357dd88a1b67`; its tree matches measured local
source `edb255e6a5db86d34de8512d13c632118224baeb`. Every raw report identifies that source
revision and exact measurement-tool hash.

The database-free aggregation tool verifies those hashes through Git, retains raw samples and
automatically regenerates grammar coverage and both report files. Five adversarial controls
(wrong tool, unqualified outcome, invalid timing, invalid byte count and conflicting observations)
are rejected without changing the current JSON report. These fixtures produce 5,532–6,033-byte
one-query durable closures, with 270–386-byte standalone plans already included inside them.
The separate small fixture schema is not a full application/server catalog. No native application
scaling or engine latency ranking is inferred from these observations.

The same aggregate CI catches an instrumentation typing gap: PostgreSQL and packed E2E projects
disable JavaScript inference and require a declaration for the new helper. A repository-only
`measure-native.d.mts` now owns its fixture input type and the JavaScript JSDoc refers to it.
Both exact E2E `tsc` commands and the root typecheck pass locally. Source quality/performance,
SQL Server native, embedded, editor and build jobs pass in the preceding CI; a fresh aggregate run is
required for the declaration fix. The separate experimental MySQL 26.7 native profile remains
unqualified and is not counted among successful native profiles.

Vocabulary source review also confirms that the current PostgreSQL reference inventory includes
SQL-standard-only appendix words without PostgreSQL reservation classes, while MySQL/SQL Server
reference snapshots do not supply a complete keyword category. Runtime keyword generation must
use pinned authoritative word tables and grammar-owned contextual rules; treating those current
reference lists as reserved-word truth would introduce incorrect mappings. This remains unfinished.

## PostgreSQL authoritative vocabulary

Selected PostgreSQL 14–19 analyzers consume compact generated keyword declarations with native
reservation classes and bare-label permissions. `grammar/postgres/vocabulary/sources.json` pins
exact source revisions, content hashes, lengths and notices; the refresh reads only those locked
files. `pnpm postgres:vocabulary:refresh` is the explicit network-capable operation.
`postgres:vocabulary:generate` and the quality gate's `postgres:vocabulary:check` operate offline
from committed, digest-checked facts. Source parsing rejects unfamiliar declarations, categories,
label flags, duplicate names and preprocessor conditions instead of omitting them.

The six profiles represent 2,884 versioned declarations with 456 shared and 148 profile-specific
stored tuples. They cover inventory classification and identifier contexts, not every associated
SQL production. Selected cores import one version and shared facts. Lightweight runtime/profile
and frozen consumers do not load the inventories; packed proofs remove the vocabulary directory.
The interpreter identity carries only a digest and retires receipts from preceding interpretation
rules. ASCII-only folding preserves Unicode identifier distinctions throughout resolution.

Generated unit cases cover every profile's keyword lookup, quoting, ColId/CTE names, qualified
columns, explicit/bare column labels and relation aliases. Native E2E discovers the actual major,
compares `pg_get_keywords()` with the generated declarations, and checks independently generated
PREPARE/DEALLOCATE probes without executing them. Bare-label probes reference the resulting name
so postfix expressions such as `ISNULL` cannot count as successful aliases. Local PostgreSQL 18.3
passes the complete oracle and native contract flow; other majors require the hosted matrix.
The other four grammars' authoritative vocabulary integration remains outstanding.

The refreshed language baseline changes 76 PostgreSQL function observations from unknown-call
to unverified invocation for special forms (`ANY`/`SOME`, SQL value functions and related reserved
syntax). No typed recognition is lost. Keyword findings now report native reservation classes;
previous synthetic terminals (`COUNT`, `MIN`, `MAX`, `SUM`, and pre-introduction `MERGE`/`MATCHED`)
are no longer represented as vendor keywords. Other grammars' observations are unchanged.

Local validation for this milestone: clean build and root types; all 41 PostgreSQL package files
with coverage 97.36% statements / 91.11% branches / 97.85% functions; all 49 repository contract
files including packed consumers; nine soundness files; PostgreSQL and packed E2E project types;
the full PostgreSQL 18.3 native helper; quality, documentation checks/build and isolated
performance budgets. The language baseline changes were reviewed by category and status, rather
than accepting new gaps as semantic support. Hosted multi-major qualification is still pending.

## SQLite authoritative vocabulary

SQLite consumes hash-pinned `mkkeywordhash.c`, `parse.y`, `tokenize.c`, VERSION and source notices.
Profiles cover every supported minor release's initial patch plus additional exact matrix/source
targets: 19 profiles and 2,804 versioned declarations. Factoring retains 140 shared rows and three
distinct delta packs, rather than nineteen complete copies. Source predicates retain compile-option
conditions, token-class membership, fallback permission and native contextual classifiers. The
3.42 boundary preserves the expanded join-word expression class; 3.47 introduces the optional
ordered-set keyword. Keyword discovery is separate from parser terminal dispatch.

`sqlite:vocabulary:refresh` explicitly reads verified cached files or fetches exact locked URLs.
Generation/checks use committed facts offline and reject source-pin/fact/digest/notice mismatches.
Unknown declaration formats, mask conditions, name productions and classifier implementations
require review. Neither normal builds nor editor/offline checks fetch upstream sources.

Column and relation bare aliases are distinct contexts: pattern operators can shift in an
expression even though their tokens fall back to identifiers elsewhere. A leading RECURSIVE after
WITH also has a syntax production; generic identifier probes place names after a seed CTE so they
test the intended context. WINDOW/OVER/FILTER classification follows native lookahead and preceding
tokens. Inventory tests cover every declared name and all nineteen profiles. Native candidates are
prepared without executing them; CLI probes run EXPLAIN on literal-only owned statements.

The native SQLite matrix builds a small keyword-API companion from the same object and flags as
the CLI. It reports `sqlite3_keyword_count/name` and compares the complete active inventory with
source predicates. Compiler/library/compile options remain in the matrix context. Keyword and
context evidence is recorded separately from the pre-existing SQL-metadata inventory: Node does
not expose the C keyword API and explicitly records it unavailable. All words are generated from
source facts; there is no separately maintained test keyword list.

Local SQLite 3.39.0 passes all 147 active keyword comparisons and 1,029 context probes. SQLite
3.54.1 passes all 147 active keyword comparisons and 1,036 context probes, including the inactive
optional keyword. Node 24's SQLite 3.53.4 passes 1,036 context probes. The CLI matrix's independent
reviewed-inventory gate remains red for the local Clang build contexts; these contexts are not
silently accepted as hosted baselines. Required hosted qualification remains pending.

The SQLite interpreter/reconciliation revision retires prior receipts. Runtime and frozen packed
consumers work after the vocabulary directory is physically removed; only the pure revision digest
remains. Local validation passes clean build/root types, all 19 SQLite package files with enforced
coverage (94.05% statements / 88.68% branches / 98.31% functions), all 49 repository contracts,
nine soundness files, focused vocabulary/matrix contracts, quality, documentation check/build and isolated performance
budgets.
The refreshed reference audit changes only the 147 SQLite keyword observations into native
context classifications; no function observations change.

## MySQL authoritative vocabulary and native function binding

MySQL 8.4.11, 9.7.2 and 26.7.0 source profiles pin lexical symbols, grammar declarations, the native
keyword generator and the ordinary native function registry. There are 2,364 versioned lexical
word declarations, represented by 769 shared and 57 profile-specific rows. Optimizer hint names
remain a separate audit namespace; capturing their names does not implement their semantics.
Reservation annotations reproduce the native keyword generator and match the complete local
INFORMATION_SCHEMA.KEYWORDS inventories: 734 names on 8.4.11 and 760 on 9.7.2.

Semantic actions are discarded while reading grammar productions. Production reachability and
nullable suffixes supply function-head and bare-constant permissions; native registry membership
supplies ordinary-call dispatch facts. Unfamiliar source declarations, namespace/reservation rules
or registry layouts fail extraction. Full token/provenance data remains in audit JSON. Runtime
modules contain only names and compact flags, with shared facts and exact series deltas. Selected
analyzers import one series directly; the compatibility analyzer retains explicit selection.

Special function names become function tokens when a following parenthesis satisfies native
whitespace rules. IGNORE_SPACE changes that lookahead, rather than universally reserving each
name in every context. Quoting or separating names with comments can select an ordinary routine.
Those AST calls skip unrelated built-in rules while preserving argument types and source spans;
suitable declared routines can resolve them, otherwise core analysis requests qualified evidence.
ASCII keyword/native-rule matching cannot turn a Unicode lookalike into a different built-in.
Identifier collation remains separate. Non-native Unicode whitespace does not silently join tokens.
Non-callable keyword heads cannot borrow ordinary-call parsing. Schema-qualified calls likewise
resolve through declared routines rather than unrelated special built-in rules. Runtime routing
uses the same compatibility analyzer pipeline as compilation; spaced or quoted ordinary spellings
retain unknown volatility and route conservatively to the primary.

Generated identifier/alias probes also enforce expression-shift restrictions for MEMBER and SOUNDS.
The owned native audit checks every declared word under ordinary mode and IGNORE_SPACE, prepares
candidates without executing them, clears owned statement-cache entries and restores the session.
It independently compares the complete keyword API, then discovers valid NULL-argument invocations
for special function names and checks their spaced/quoted binding. Functions needing distinct
syntax/signature evidence remain unverified by that invocation probe; no universal result rule is
inferred from preparation.

Local native audits pass 10,766 identifier probes on 8.4.11 and 11,144 on 9.7.2 plus discovered
function-binding probes. Both full native contract helpers also pass acquisition, context drift,
conflicts and offline reuse. Canary source data is generated and statically tested but its native
transport remains unqualified. Normal generation/checking stays offline; only explicit refresh
can fetch locked sources. Shared source-cache/formatting/factoring mechanics now serve the three
implemented vocabulary generators, with unchanged PostgreSQL/SQLite outputs. Source notices and
license text are retained separately from executable package code.

The interpreter/reconciliation revision retires prior receipts. Packed runtime/frozen consumers
work with the MySQL vocabulary directory removed. Local validation passes a clean build/root
types, all 30 MySQL package files with coverage 96.38% statements / 91.56% branches / 98.93%
functions, all 49 repository contracts, nine soundness files, MySQL E2E test-harness types, quality,
isolated performance budgets and documentation check/build. The final native 8.4/9.7 contract
helpers also pass after routing and ordinary-call guards are integrated. The reviewed reference audit changes only IN, JSON_TABLE and MATCH
across three profiles (nine unknown-call observations become unverified syntax invocations);
no typed recognition is lost. DuckDB/SQL Server vocabulary, final native facet/context/workload
qualification and refreshed final measurements remain outstanding.


## DuckDB independent source vocabulary and native context oracle

The MySQL vocabulary milestone at `8e050295` passes
[main CI](https://github.com/Lojhan/typed-sql/actions/runs/42581926664).
The optional MySQL 26.7 canary transport still fails its explicitly nonblocking qualification;
it is not promoted to native support.

DuckDB source vocabulary is now captured independently for both exact supported engines. The
1.5.6 Yacc declarations and 2.0 PEG keyword maps are separate source profiles, verified against
immutable revisions and hashes. Each profile retains overlapping column/function/type name
permissions separately from the metadata API's displayed category. The generated audit stores
484 shared rows and 23 profile-specific rows, plus the separate 2.0 bare-label permission list.
Native APIs match all 489 records on 1.5.6 and 508 records for 502 distinct words on 2.0.
Collapsing the latter API into one category per spelling would discard six overlapping records.

The native contract suites now prepare every declared word in eight identifier contexts: explicit
and bare column aliases, CTE names, explicit and bare relation aliases, qualified columns, quoted
CTE names and prefix column aliases. Candidates are never executed and every owned statement is
destroyed. The wrapper for bare column aliases rejects operator interpretations that do not
produce the requested name. All 3,912 probes on 1.5.6 and 4,016 on 2.0 pass. Keyword aliases
without AS are rejected on 1.5.6; the explicit 358-word bare-label list matches 2.0's accepted
subset. Explicit AS labels and qualified attributes permit all declared words on both engines.
Column/relation/CTE name eligibility uses the actual overlapping unreserved/column declarations.

The source extractor fails on unfamiliar declarations, duplicate/conflicting classes, changed
identifier productions, changed native maps or disagreement between authored lists and shipped
lexer/map records. Its Yacc reader now handles inline production terminators while preserving
quoted semicolons and discarding semantic actions. MySQL source refresh produces unchanged facts
and runtime projection with that shared-reader improvement. Normal source checking stays offline.
Only explicit refresh may fetch locked inputs. Source notices are retained independently.

This milestone supplies the independent audit oracle. DuckDB analyzer/parser integration is
still outstanding; passing the native audit does not establish host-parser parity or function
semantics. SQL Server source integration, the final native context/facet/workload audit and final
measurements also remain open.

Local validation passes root types, all 42 DuckDB package files with enforced coverage
(98.88% statements / 91.22% branches / 97.81% functions), the separate 1.5.6 native process,
all 49 repository contracts and quality/source-generation checks. No production analyzer
implementation changes in this audit-only milestone.


## DuckDB vocabulary consumption and native display labels

Both selected full/core analyzers now consume their exact generated vocabulary directly. The
compatibility analyzer selects an exact qualified engine; no newer-version fallback is invented.
Version-specific graphs contain one vocabulary profile and exclude the compatibility registry
and other engines. Runtime/profile/frozen graphs retain only a pure interpretation revision;
packed frozen consumers also physically remove DuckDB's vocabulary directory.

The parser applies overlapping identifier/function-name permissions, explicit labels and the
separate 2.0 bare-label list. Special function heads are extracted from the pinned expression
productions instead of treating every column keyword as an ordinary function. The additional
2.0 expression source is hash-locked. Source inventory/context probes and parser tests cover all
7,928 identifier cases across the two engines. TRY_CAST becomes constructor syntax only with
a following parenthesis; EXISTS can remain an ordinary name outside subquery syntax. Bare
alias lookahead retains BETWEEN's operator behavior with real operands, including quoted
keyword-named columns. ASCII folding in handwritten resolver paths preserves Unicode lookalikes.

Generated display labels no longer use the short manually declared keyword set. Both native
engines quote every keyword when rendering a column reference inside an expression. All 991
versioned words now have an additional non-executing native label check and a selected-core
analyzer assertion for exact result name and known number output. This preserves the distinction
between source spelling, namespace eligibility and native result-column identity. The updated
interpreter/reconciliation identity retires receipts from the preceding rules.

The reference baseline changes all 991 DuckDB keyword observations into source-owned classes.
The only function differences are SHOW on the two engines: unknown-call observations become
unverified syntax invocations. No typed recognition is lost, and other grammars' observations
are unchanged. No overload/result semantics are inferred merely from a function-head permission.

Local validation passes clean build/root types, all 43 DuckDB package files with enforced
coverage (98.93% statements / 91.30% branches / 97.51% functions), native helpers in separate
1.5.6 and 2.0 processes, all 49 repository contract files including stripped frozen consumers,
nine soundness files, documentation check/build, graph checks, quality and isolated performance.
Compiler semantic-metadata p50 is 7.48 ms against the unchanged local 10 ms budget.

The preceding audit-only [hosted run at `a05f4daf`](https://github.com/Lojhan/typed-sql/actions/runs/42583640548)
passes its native jobs but fails source-quality at compiler semantic-metadata p50 20.85 ms
against the existing hosted 20 ms limit. That failed aggregate is not counted as qualification.
The integrated implementation requires its own green hosted aggregate; no budget is relaxed.
SQL Server vocabulary, final per-profile context/facet/workload evidence and refreshed final
measurements remain outstanding.


## SQL Server source vocabulary and native reconciliation audit

The DuckDB integration at `a1673bbb` passes
[main CI](https://github.com/Lojhan/typed-sql/actions/runs/42585766197), including the required
native profiles and unchanged performance budgets. The earlier audit-only performance failure
is not counted as qualification; the integrated revision has its own green aggregate.

SQL Server vocabulary now has an independent hash-pinned Microsoft ScriptDOM source map at
`3ea69b6fc1ed76b63eca6df868f3d1347b92e9fb`. Four version-owned lexer/parser files and the
common token/constant declarations represent every supported engine and all ten compatibility
pairs discovered from the owner policy. The source map records 1,889 shared ASCII words,
including 180 declared literal tokens, plus 25 non-word constants in a separate namespace.
Contextual code-generation words are not mislabeled as reserved tokens or function semantics.
All four current source profiles have identical word facts; source/profile identities remain
separate. Full vendor grammar inputs are cached outside Git, with bounded size and digest checks.
Only the SQL Server owner opts into the 2 MiB input bound required by its parser files; other
owners retain the preceding 1 MiB default. Normal checking stays offline.

The extractor rejects unfamiliar token/constant layouts, duplicate/conflicting literal names,
unknown identifier permissions, unsupported profiles and source-pin drift. Microsoft source
notices are preserved. This external parser is evidence, not an assertion of engine identity: its
source explicitly records lexer approximations, so the next gate compares actual engine behavior.

The existing owned native catalog matrix now describes all 1,889 words in eight identifier
contexts per engine/compatibility pair: explicit/bare column aliases, CTEs, explicit/bare relation
aliases, qualified columns, bracket-delimited CTEs and assignment aliases. That is 15,112 generated
candidates per pair and 151,120 across the matrix. Candidate statements never execute. Native
metadata requests are batched; only classified SQL errors permit individual description fallback.
Authentication/transport failures propagate. Missing/duplicate native protocol identities fail;
unavailable metadata remains unavailable and cannot certify keyword rejection. Actual result
names must match the requested identifier role. Each profile records native permission masks,
source disagreements, batch/fallback counts and duration alongside its exact native environment.
Any disagreement or unavailable facet keeps the native gate red for reconciliation.

Local source-generation checks, root types, all 25 SQL Server package files with enforced
coverage (96.91% statements / 91.71% branches / 95.83% functions), 50 repository contracts and
quality pass. Fault controls exercise unexpected source layouts, native source disagreements,
wrong result names, classified fallback, authentication/transport failures, absent/duplicate
protocol rows, unavailable negative evidence and unqualified profiles. These tests qualify the
mechanism; real SQL Server metadata acquisition requires the hosted x86-64 engine matrix.

SQL Server runtime/parser consumption and any source/native reservation differences remain
unfinished until that native evidence is reviewed. This phase changes audit tooling and license
metadata, not production grammar inference. Final per-profile context/facet/workload evidence and
refreshed final measurements remain outstanding.


## SQL Server native response-shape follow-up

The initial SQL Server source-audit [run at `af2ac81c`](https://github.com/Lojhan/typed-sql/actions/runs/42587556126)
reaches the real native catalog step but stops at duplicate descriptor identities. The first
completed 14/140 artifact therefore contains no vocabulary qualification; it is not accepted
as word/context evidence. All four native jobs fail in that run.

The audit now groups a candidate's native response rows. Multiple explicit error records are
preserved as rejection evidence; authorization-denied records remain unavailable. Ambiguous
column metadata is independently re-described through a separate single-candidate request.
Only a complete single-column descriptor with the exact expected result name can qualify that
request. Repeated successful metadata, mixed error/column data or absent descriptors cannot
become success. Unexpected native probe identities and missing batched identities still fail.
The artifact separately counts batched errors, individual descriptions and ambiguous-descriptor
fallbacks, and includes its producer digest and explicit context-bit ordering.

Focused fault controls now cover multiple errors, denied metadata, successful individual
re-description and an ambiguous response that remains unavailable after re-description. Root
types and quality pass. Production grammar behavior is unchanged; native source reconciliation
and SQL Server parser integration still require actual completed matrix evidence.


## SQL Server complete native source reconciliation

The response-shape follow-up at `24cbc659` completes all 151,120 word/context descriptions
across the ten exact engine/compatibility pairs in
[run 42588817146](https://github.com/Lojhan/typed-sql/actions/runs/42588817146). Each pair
records 15,112 cases; the 14/140 observation takes about 1.3 seconds using 237 batches. No
candidate executes. The aggregate remains red because the new audit correctly exposes source
disagreements; it is not represented as a green PR qualification.

Nine comparisons differ from ScriptDOM on each of the first nine native scopes: STOPLIST is
accepted in the seven unquoted identifier contexts despite its external lexer declaration,
and XMLNAMESPACES / CHANGE_TRACKING_CONTEXT are rejected as unquoted CTE names. The 17/170
profile additionally rejects REGEXP_LIKE in all seven unquoted contexts. Earlier compatibility
levels on the same engine permit that identifier. All bracket-delimited CTE probes pass.

`sqlserver:vocabulary:reconcile` reads complete catalog artifacts, checks the producer against
its committed source, verifies source/word digests, exact native versions and every required
engine/compatibility pair, and requires every word/context permission. The resulting small
`qualification.json` retains four artifact digests, three shared deltas and one scoped delta.
Its original producer is `24cbc659`; the artifact paths below reproduce the reviewed import:

```sh
pnpm sqlserver:vocabulary:reconcile 24cbc659ab875d3e46c177183b8ed33f964f1619 42588817146 /path/to/downloaded-artifacts/*/catalog-*.json
```

The native auditor now checks reviewed engine permissions while preserving the original source
disagreements separately. Source changes retire the reviewed policy; a stale policy cannot
produce a matching qualification. Native metadata limitations remain unavailable, while definite
syntax/binding errors can establish rejection. Native error types are captured explicitly rather
than treating every metadata limitation as a syntax failure. This stricter reader requires fresh
hosted qualification. Runtime/parser consumption is the next integration step.

Fault controls reject missing native scopes, wrong producer/source identities, incomplete probes,
missing/foreign words, invalid permission masks, wrong native versions, changed context ordering,
duplicate profiles, mutated reviewed permissions and unavailable metadata. The reviewed data
qualifies identifier contexts only and never generates a function result rule.

## SQL Server parser integration and cancellation ownership

The reviewed native policy passes all four SQL Server engine jobs in
[run 42592102996](https://github.com/Lojhan/typed-sql/actions/runs/42592102996), including
all ten compatibility pairs. The same aggregate fails source quality when the cancelled live
catalog test removes its cache directory while a shared context observation is still publishing.
Its optional MySQL canary is also unqualified; this is not a green aggregate.

The SQL Server analyzer now selects vocabulary from the actual four-part server version and
compatibility level. Runtime declarations factor into 181 shared permission rows and one
17/170 delta for REGEXP_LIKE. The generated runtime vocabulary and pure identity occupy 220
lines; complete source words and reviewed native provenance remain audit inputs outside the
application runtime graph. The interpreter/reconciliation identity changes so prior contracts
require regeneration. Ordinary runtime and frozen consumers retain only the pure identity.

The parser checks explicit/bare column aliases, CTE names, relation aliases, qualified columns
and assignment aliases. Quoted names do not act as structural keywords, operators or builtin
constants. Tests derive all 151,120 context cases from the independent inventory and reviewed
native masks; 18,890 selected-core quoted-column analyses additionally assert numeric types,
nullability and parameter absence. Core rejection controls prove that vocabulary selection is
active and check source spans; parameterized controls retain ordered bindings. These counts
qualify the declared identifier contexts, not every SQL Server syntax or Unicode collation rule.

Session shutdown now cancels native context waits and drains context inspection/publication
before returning. A deterministic gated disk-publication regression cancels the source request,
proves shutdown remains pending, releases the write and verifies that shutdown then completes.
Late native failures cannot retire cache evidence after cancellation. The analysis package's
coverage suite passes at 98.58% statements / 93.15% branches / 99.46% functions. SQL Server's
26 test files pass at 96.94% / 91.78% / 95.65%, respectively.

Local validation passes typecheck, clean full build, all 50 repository contract files, all nine
soundness files, documentation checks, source quality and isolated unchanged performance gates.
Packed frozen/runtime verification physically removes vocabulary and analysis directories for
every declared grammar, including SQL Server. Fresh hosted qualification, per-profile facet and
invalidation reconciliation, native application-workload scaling and final cost measurements
remain outstanding.

## Native facet evidence retained with measured acquisitions

The native-cost recorder now publishes version 2 observations. Each acquisition reloads its
exported durable contract through the actual contract validators, then retains the native
column/parameter descriptors and qualification comparisons under a canonical digest. Repeated
identical observations share one record. Timed samples reference that record; timing or a
successful runtime-type policy never upgrades other facets to complete.

The aggregator validates native evidence and its complete comparison closure, checks the adapter,
observation hashes and exact sample coverage, and renders a per-profile column/parameter facet
table. Version 1 inputs explicitly say "not recorded". Fixtures without parameters say "none in
fixture". An isolated synthetic regression proves that partial type/nullability evidence survives
successful qualification and that a rehashed false completeness claim fails without replacing
the prior validated report. The optional output-directory argument keeps these checks outside
the repository's published measurements.

Actual local native helpers pass on PostgreSQL 18.3, MySQL 8.4.11/9.7.2, DuckDB 1.5.6/2.0.0 and
Node's SQLite 3.53.4. Their version 2 reports use committed recorder `7bb092a8`; raw files are in
`/tmp/typed-sql-native-facets-20261109`. All six parameterized fixtures establish runtime types.
The selected PostgreSQL/DuckDB fixtures retain unknown native nullability; MySQL retains partial
column native type and nullability plus unknown parameter nullability; SQLite retains partial
storage-class native types and nullability. These are invocation-specific observations, not
universal engine guarantees. Ten older hosted SQL Server cost profiles are retained without
fabricating missing facet records; fresh hosted capture is required to fill them.

The refreshed report preserves all 16 cost profiles and distinguishes their revisions. Local root
types, the focused aggregation regression, all 51 repository contracts and source quality pass.
This closes an evidence-retention gap, not the remaining authorization/search-path/codec/engine
mutation matrix or application-workload scaling requirement.

## Context mutation proof and SQL Server permission identity

The [per-profile invalidation matrix](./context-invalidation.md) now separates actual native
mutations, guarded/rejected environments and gaps that remain unverified. PostgreSQL's real
18.3 helper changes the current principal, an explicit permission grant, search path and time
zone while keeping the compiler schema fixed. Each changes native context and rejects acquisition
under the prior identity. Its codec-policy case keeps native database identity fixed and checks
the type-policy/codec hashes plus rejected reuse.

Actual policy-isolation regressions also pass on MySQL 8.4.11/9.7.2, SQLite 3.53.4 and DuckDB
1.5.6/2.0.0. The complete PostgreSQL and both MySQL native helpers pass. SQL Server now has
equivalent hosted BIGINT-policy cases for all ten compatibility pairs, awaiting execution.

Source review found that SQL Server's fingerprint included principal tokens but did not
explicitly include permission grants. It now captures a bounded explicit database permission
inventory plus effective database/server permissions. Unit controls mutate each evidence set,
reject reuse and reject overlarge inventories. A new hosted regression grants SELECT to an
otherwise unrelated database role, holds the current principal/schema fixed, rejects the prior
context and then revokes the grant. The native adapter identity advances to v3 and old SQL
Server native contracts require regeneration. Native grant/revoke qualification remains pending.

Local validation passes root types, clean full build, 26 SQL Server package test files with
enforced coverage, all 51 repository contract files, all nine soundness files, source quality
and isolated unchanged performance budgets. SQL Server coverage is 96.94% statements / 91.80%
branches / 95.65% functions. No performance budget or timeout is increased.

The preceding parser-integration [run at `3f25039d`](https://github.com/Lojhan/typed-sql/actions/runs/42594179077)
passes all four SQL Server engine jobs and completes the source tests. Its source job fails
the final editor edit-storm performance assertion at 15.26 ms against the unchanged hosted
15 ms limit; this is not a green aggregate or a claimed performance fix. Its manual upstream
reference refresh separately fails on HTTP 403 from the MySQL documentation endpoint, and the
optional MySQL canary remains unqualified. Fresh qualification must evaluate the current code
and capture version 2 SQL Server facet records. Scenario 8's remaining applicable mutation
classes, workload scaling and final measurements are still open.

The first permission-mutation [run at `2f32cdfe`](https://github.com/Lojhan/typed-sql/actions/runs/42596294995)
stops all four SQL Server native-contract probes at the new bare initial context observation:
the existing consistency guard reports `context-changed` before any grant mutation runs.
The 14/140 job subsequently passes its packed native consumer checks. This does not qualify
the new permission cases or provide missing facet samples.

Initial context observations now use the same three-attempt, context-change-only bound as
the pre-existing acquisition fixtures. Every attempt is recorded, exhaustion still fails,
and other errors fail immediately. There is no sleep, enlarged deadline or accepted inconsistent
context. Probe artifacts retain incomplete case status, observation attempts and cleanup status
even on failure, with acquisition/cleanup/publication failures preserved together. Fresh hosted
execution must establish whether a stable initial observation and every mutation case pass.

## MySQL authorization and environment mutations

MySQL native context now explicitly captures direct grants, enabled role identities and effective
role grants. Structured role metadata is individually quoted before `SHOW GRANTS ... USING`;
rendered role text is never executed or spliced. Grant statements are hashed as evidence only,
not executed or interpreted as routine mappings. Empty, malformed, denied or overlarge grant
evidence stays unavailable. The native adapter identity advances to v3, requiring prior native
contracts to be regenerated.

The [real mutation helper](../../test/helpers/mysql-context-mutations.ts) passes on both 8.4.11
and 9.7.2. It changes a direct permission, enabled role, effective role permission, authorization
principal, selected database and semantic time zone, keeping the compiler schema fixed and
requiring acquisition with the old context to return `context-mismatch`. A changed SQL mode
declines qualification against the old schema environment. The role includes a backtick,
qualifying the native metadata quoting path. Its own account/role/grants are cleaned up.

Unit controls independently cover all three authorization evidence sets, quoted role identities,
malformed/missing grants, denied access, bounded role/grant inventories and bounded generated
metadata statements. All 30 MySQL package files pass enforced coverage at 96.39% statements /
91.63% branches / 98.93% functions. Both complete real MySQL native helpers pass, followed by
focused native setting/mode assertions on both engines.

Root types, clean build, all 51 repository contracts, all nine soundness files, source quality,
documentation checks/build and unchanged isolated performance budgets pass. The local editor
edit-storm p50 is 5.58 ms; the historical hosted 15.26/15 ms failure is not represented as fixed.
The invalidation matrix records these native proofs and retains engine-replacement/other-profile
gaps. Hosted MySQL qualification, SQL Server permission/facet capture, native application
workload scaling and final measurements remain outstanding.

## Complete measured native facet capture

The focused [SQL Server run at `b24cedd8`](https://github.com/Lojhan/typed-sql/actions/runs/42597621667)
passes all four engine jobs. Downloaded transport artifacts are:

| Major | Artifact ID | Local audit directory | Passed cases |
| --- | --- | --- | --- |
| 14 | 13663159848 | `/tmp/typed-sql-context-b24-14` | 13 |
| 15 | 13663568908 | `/tmp/typed-sql-context-b24-15` | 26 |
| 16 | 13663603925 | `/tmp/typed-sql-context-b24-16` | 39 |
| 17 | 13664726668 | `/tmp/typed-sql-context-b24-17` | 52 |

Each native-contract artifact reports passed cases and cleanup, includes the exact compatibility
pairs from the pinned vocabulary profile, and records codec-policy and permission-grant
context mismatch proofs for every pair. Each engine's first baseline observation records one
`context-changed` rejection followed by a stable observation on attempt two. Subsequent baseline,
codec and grant observations succeed on their first attempt. Inconsistent observations are not
accepted. All 130 cases pass; no deadline or budget changes are used.

All ten SQL Server cost records now contain version 2 facet observations with three independently
qualified acquisitions per pair. The aggregator verifies committed producer hashes, native
evidence, qualification closures, adapter identity, canonical evidence hashes and sample coverage.
For the selected BIGINT column/parameter invocation, native and runtime types are complete;
nullability remains partial. This does not generalize the invocation into a universal function
rule or establish every descriptor family.

The refreshed [native report](./native-costs.md) retains all 16 measured profiles with recorded
column and parameter facets; no current row lacks facet capture. MySQL costs are refreshed from
`b601d85c` after adding grant/role metadata, using complete passing native helpers on 8.4.11 and
9.7.2 (`/tmp/typed-sql-native-facets-b601`). Four unchanged local profiles retain their exact
`7bb092a8` observations, selected separately to avoid conflicting duplicate inputs. Source
revisions and environments remain explicit. This closes the SQL Server capture/import gap;
descriptor-family review, remaining applicable context mutations, native application workloads,
current-head aggregate CI and final repository/bundle/install measurements remain open.

The full [PR run at `b24cedd8`](https://github.com/Lojhan/typed-sql/actions/runs/42597611355)
passes source verification, including unchanged hosted performance budgets. It fails its PostgreSQL
18.6 mutation helper when a fresh post-grant context capture reports `context-changed`, before
the old-context mismatch assertion can run. The optional MySQL canary also remains unqualified;
the full aggregate is not green.

The PostgreSQL mutation proof now retries only that capture error within the same three-attempt
bound. It retains the original expected context on every attempt, must still obtain a stable
capture and assert `context-mismatch`, and immediately fails on other errors or exhaustion.
Root types and the actual local PostgreSQL 18.3 mutation helper pass. Production acquisition
guards and performance budgets are unchanged; fresh hosted qualification remains required.

## Required aggregate and application admission baseline

The [full run at `8328c51f`](https://github.com/Lojhan/typed-sql/actions/runs/42599873360)
passes every required gate, including the corrected PostgreSQL 18.6 mutation proof, both supported
MySQL versions, all SQL Server engine jobs, packed/editor checks and unchanged hosted performance
budgets. The optional MySQL canary remains unqualified. This is required aggregate proof for that
revision; subsequent audit tooling still needs current-head qualification.

The [commerce admission audit](./native-admission.md) discovers all grammars from the ledger,
selects core/native factories through public export metadata, and executes their admission
prefilters against every maintained query file. There is no copied grammar/function/query list.
Its 37 finite candidates have zero static core errors. Six pass admission, 24 are declined and
seven cannot be assessed because the MySQL example has no SQL-mode evidence. The script does
not invent that evidence or convert unavailability to a successful admission. Each grammar also
has one incomplete rendering file excluded from exact native candidates.

The [JSON](./native-admission.json) retains SQL/digests, parameter occurrences, static parameter
evidence, schema/corpus input hashes, selected owner identities and every decision. Its committed
producer runs with clean library/corpus sources and a preloaded Node network-denial trap:
zero native factory calls and zero TCP/DNS/fetch attempts. The regression accounts for every
ledger grammar and maintained query file, checks the result partition and parameter bounds,
and requires every native qualification status to remain `not-attempted`.

This is an admission baseline, not actual native preparation, safe live table binding, descriptor
availability or project qualification. It exposes the native statement/binding restrictions
that must be investigated using real provisioned commerce schemas before workload scaling can
be claimed. Root types, the new regression, all 52 repository contracts and source quality pass.

## Actual native commerce workload and scaling

The [native commerce report](./native-projects.md) provisions the maintained seven-table schemas,
introspects actual versioned snapshots, discovers every finite query and independently reconciles
native descriptions at 1, 10 and 50 copies. Comment prefixes create distinct exact SQL identities;
they do not introduce new business logic or database objects. Each owned database is removed
before durable/cache replay. No application query is executed or supplied sample values.

Six local profiles use committed producer `eb1b199f`: PostgreSQL 18.3, MySQL 8.4.11 and 9.7.2,
DuckDB 1.5.6 and 2.0.0, and SQLite 3.53.4. SQLite qualifies four of seven base queries; each
MySQL profile qualifies one of seven and each DuckDB profile one of eight. PostgreSQL's admitted
account query reaches its enum-table context restriction and remains partial; its other six
queries are declined. Writes, other unsupported statement forms and each grammar's unbounded
rendering file remain explicitly accounted for. These findings do not claim full native
application support or production function popularity.

All four SQL Server jobs pass in [run 42607999785](https://github.com/Lojhan/typed-sql/actions/runs/42607999785).
Their ten engine/compatibility pairs provision and introspect the same maintained application
model. All eight base queries are declined by the current native statement/table-binding scope;
the resulting manifest-only closure is not usable application support. Initial context attempts
and database removal are retained. The reports identify the exact tested merge
`f095cc29f60c5a2249c14242987ee76616f200ca`, whose collector and fixture hashes match the committed
head producer. Downloaded transport artifact IDs are 13669530934 (14), 13670005097 (15),
13669515965 (16) and 13668124819 (17).

The aggregator validates committed collector/fixture hashes, per-scale accounting, qualification
evidence, canonical identities, context attempts and completeness claims before writing output.
Identical query/evidence observations are factored in the retained JSON. The actual SQLite
regression denies network access, checks artifact growth, preserves inferred descriptors and
ordered parameters, reopens durable/cache inputs after database removal and verifies that a
false whole-project completeness claim cannot overwrite valid evidence. It runs in the Node
SQLite matrix on runtimes with the required native metadata APIs. Root types, all 53 repository
contract files and local quality pass for the initial collector; the extended summary regression
also passes.

## Metadata comparison performance

The [run at `be37f745`](https://github.com/Lojhan/typed-sql/actions/runs/42602977574) passes required
database jobs but fails compiler semantic metadata p50 at 20.61 ms against the unchanged 20 ms
hosted budget. Profiling the same 250-query workload identifies repeated ASCII conversion as a
hot path. Direct case conversion for ASCII-only strings retains the existing non-ASCII fallback.
Exhaustive ASCII character-pair and non-ASCII BMP checks, the full PostgreSQL suite (42 files,
97.36% statements / 91.12% branches / 97.85% functions), root types and unchanged local performance
gates pass. A separate 350-sample local profile moves p50 from 5.91 ms to 5.02 ms; it is evidence
for this local workload, not a hosted performance guarantee. The full local performance gate
records semantic-metadata p50 6.73 ms against its unchanged 10 ms local budget. Hosted
qualification of the optimization remains required.

## Native session and engine context controls

DuckDB's actual integer-division mutation changes a prepared expression's native result type,
keeps compiler schema/codec identity fixed and rejects acquisition with the previous context.
Actual nondefault search-path mutation declines context inspection and acquisition. Both SDKs
pass. The declared-engine runner also captures each actual context in a separate process,
acquires successfully under that engine's own context and rejects every cross-engine reuse.
Targets are discovered from the owner policy and installed package declarations; SDK native
libraries never share a process. These are engine-context checks, not database-file migration
claims. The complete DuckDB suite passes 43 files with 98.95% statement / 91.35% branch /
97.51% function coverage, plus the other SDK's native suite and both cross-engine directions.

SQL Server's database token can be shared by distinct server logins that map to `dbo`.
The native context now includes bounded original/current login names, login SID, database-user
name and SID. Missing, malformed or overlarge identity metadata declines acquisition. Unit
controls change each identity field while holding other context facts fixed and require
old-context rejection. The adapter identity advances to v4; existing SQL Server native contracts
require regeneration. The full SQL Server suite passes 26 files with 96.95% statement /
91.82% branch / 95.65% function coverage. Root types, 53 repository contracts and local quality pass.

The real SQL Server probe now creates a disposable sysadmin login on its owned test server
before baseline capture, then impersonates it on a fresh exclusive lease. The compiler schema
and codec stay fixed; old-context acquisition must be rejected even though both logins map to
`dbo`. A second probe changes DATEFIRST and requires unsupported-context failure. Cleanup drops
the owned database/login and records failure if either cannot be removed. These native cases
require hosted qualification on every supported engine/compatibility pair; local unit coverage
does not establish those results. The broader mutation matrix and descriptor-family review
remain open.

## Qualified login identity and refreshed measurements

All four SQL Server jobs pass in [run 42610820237](https://github.com/Lojhan/typed-sql/actions/runs/42610820237).
Downloaded transport artifacts 13670273321 (14), 13670333072 (15), 13669484427 (16) and
13669813927 (17) retain 15/30/45/60 passed native cases respectively. Every compatibility pair
includes actual distinct-login impersonation and DATEFIRST cases alongside permission/codec
mutations. Case and database/login cleanup statuses are passed. The measured merge producer
is `b054a1a344a3e30c3ea4eab6e8f9b3de5ea379ea`, incorporating production head `c6d71ccf`.
The native cost aggregator verifies its committed producer and refreshes all ten SQL Server
profiles to adapter v4, retaining the six separately pinned local owner-fixture profiles.

Bundle, installation, repository and offline commerce measurements now share production-source
pin `c6d71ccff0827ae915900e6ac474e81ec965ce14`. The actual collectors complete successfully.
They measure different costs: emitted minified/gzip/Brotli graphs with attributed inputs;
published installed file closures; Git-tracked maintained/generated source and audit data;
and actual exported/reopened project contracts, schema growth and used runtime plans.
All 37 maintained finite candidates retain complete selected-core/compatibility analysis equality.
Runtime/profile/frozen graphs retain zero global catalogs.

The source inventory contains 337,321 fewer tracked text lines than the exhaustive proposal.
Relative to the PR base, maintained package source grows 15,273 lines, generated package source
5,724 lines and tests/E2E source 22,176 lines. The measured PR diff is +98,702 / −17,172;
captured vendor catalog JSON is absent. Retained baseline catalogs, generated vocabulary/codec
projections, tests and audit/report data remain separately classified. These are measurements
of the exact named revision, not a claim that later edits to report files were included.

The report renderer derives all three cost-document tables from JSON, asserts common code pins
and matching grammar sets, and checks catalog isolation. Its `--check` mode is part of root
quality and opens no native services. Native workload measurements keep their own explicit
source pins and unsupported/partial outcomes. Descriptor-family review, remaining applicable
context boundaries and current-head aggregate CI remain open.

The [full aggregate at `c6d71ccf`](https://github.com/Lojhan/typed-sql/actions/runs/42610820237)
now passes every required gate, including source quality, types/coverage, documentation,
packed/editor/build integration, all required database jobs and unchanged hosted performance.
Compiler semantic-metadata p50 is 19.9836 ms against the 20 ms hosted budget; the pass does not
provide a large performance margin. The optional MySQL canary remains unqualified. The report
refresh and root quality integration still need their own current-head aggregate after publication.
Local quality/docs checks pass; a deliberately stale derived table fails `--check` and exact
restoration passes. No native services are loaded by that check.

## Inventory-driven DuckDB descriptor audit

The [descriptor-family review](./descriptor-families.md) adds live type discovery independent of
the source alias map. Both exact engines probe every internal type spelling as output and input,
retaining namespace locations and requiring agreement before grouping duplicate names. Concrete
controls cover all modeled kinds through a TypeScript-exhaustive record, with exact native
logical-tree/modifier and runtime-policy comparisons. They use NULL/typed parameters without
candidate execution, binding or sample application values. Detailed JSON is captured in CI;
reviewed semantic fingerprints exclude host/provenance noise while retaining every name,
classification, SQL probe, outcome and field descriptor.

The audit exposes six missing common scalar aliases. Actual catalogs agree on their canonical
types on both engines, and actual output/parameter acquisitions confirm them after the fix.
Only those six offline type observations change on each reference target; restoring their
prior classifications reproduces the entire previous reference baseline. No new reference
gaps are accepted and recognition remains labelled semantics-unverified. The native adapter
advances to v4 and reconciliation owner to v3; old captured DuckDB contracts need regeneration.

Committed producer `f44f49ad1c5d2c9d361e1b8d24dc396044e0fe18` captures 83/84 internal spellings
and 244/316 namespace rows on 1.5.6/2.0.0. Each engine acquires 73 bare output descriptors,
72 bare parameter descriptors and all ten output/input constructed controls: 165 acquisitions
per profile. The NULL-typed input remains unavailable; bare parametric/pseudo names are not
misreported as unsupported entire families. Exact SDK package versions and collector Git
hashes are retained. Native suites compare fresh facts with the reviewed fingerprints rather
than silently accepting drift. Root types, both native suites, full DuckDB coverage, all 53
repository contracts and local quality pass. Other owners and descriptor-policy/class gaps
remain open; this is not a complete five-grammar capability certificate.

## PostgreSQL descriptor inventory capture

Committed collector `745a48a0c13ad214ff96907436f70aa491c28ec6` independently discovers 329
bootstrap non-relation types on PostgreSQL 18.3 and runs output/parameter Parse/Describe probes,
plus 12 modifier controls. No candidate is bound or executed. The 670 observations distinguish
46 acquisitions, 612 engine-described adapter declines, ten engine rejections and two JSON
parameter-runtime unavailability cases. Known column typmods remain complete while parameter
modifier identity remains incomplete. Counts and boundaries are in the
[descriptor-family review](./descriptor-families.md#postgresql-catalog-driven-observations).
Root typechecking and quality pass, and a committed-source recapture reproduces the semantic
fingerprint. All six PostgreSQL CI profiles now capture their own protocol observations and
upload detailed JSON, including explicit unavailable adapter status outside its qualified major.
Hosted qualification and reviewed drift fingerprints remain pending. Scenario 17 stays partial;
this initial catalog review does not qualify custom types, policies or arbitrary compositions.

The same committed source refreshes both DuckDB native fixture costs and commerce measurements
after its adapter/owner epoch changes. Three observations per fixture and 1/10/50-copy application
captures retain the previous byte sizes and qualified subsets, with zero disconnected native calls.
Other profile observations retain their original source identities rather than acquiring a new pin.

Review findings are checked separately: the repository classifier now expresses its anchored
root-directory test and nested-directory test as distinct alternatives. The source-refresh network
findings are dismissed as false positives after inspecting each owner's exact vendor URL/revision/
path checks and the cache's validated digest-only destination plus exact length/content checks.
No file data or arbitrary application value is added to a request; verified source bytes are
intentionally cached without execution. No scanning rule or package-wide exception is disabled.
