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

The exhaustive upstream inventory, vendor fact extraction, global catalog model, generated
completeness reports and selected-version/core/compatibility-pack APIs are excluded. Normal
builds and installations do not fetch database sources or require a global engine inventory.
The existing PostgreSQL/MySQL catalog generators also derive small runtime codec projections
from their maintained catalog inputs, preserving compile-time/runtime policy agreement.

## Qualification limits

PostgreSQL native acquisition is restricted to the documented expression-query profile.
DuckDB native acquisition supports builtin scalar expression projections on 1.5.6 and 2.0.0;
its real-engine tests exercise the shared live runner, persistent cache, offline reuse and conflicts.
DuckDB packed CLI generation, changed-query regeneration and frozen checking pass on both SDKs;
its packaged editor path is also qualified for SQL documents and TypeScript templates. MySQL, SQLite and SQL Server retain
their existing offline support and contract-profile interfaces without native acquisition qualification.
Build transforms and `typed-sql-build types` consume durable query contracts. Frozen builds avoid
analyzer/native initialization; offline and live-configured builds use offline rules for unrecorded
queries without opening a database. Build inputs exclude the disposable development cache.
Project routine catalog library APIs support PostgreSQL fixed scalar declarations. Automatic
catalog generation/refresh in the CLI and editors, other grammar interpreters, custom type/rule
qualification and workload-selected offline packs remain incomplete.

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

These changes qualify metadata capture and verification, not MySQL contract acquisition.
That adapter still needs a qualified consistency guard, binding scope and reconciliation owner.

Validation: the full developer E2E flow passes on MySQL 8.4.11 and 9.7.2 under all three maintained
SQL-mode profiles (default, lexical and numeric). Each flow includes native protocol checks,
compiler verification, runtime decoding and reviewed independent language recognition. No live
baseline or native finding is changed to accept the corrected argument bounds.
