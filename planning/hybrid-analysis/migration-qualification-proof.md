# Migration-derived query-contract qualification

`assertMigrationContractConsumer` in `test/helpers/migration-contracts.ts` connects acceptance
scenario 21 to the existing packed frozen consumer. The PostgreSQL developer-flow E2E suite
invokes it for the native acquisition owner's qualified PostgreSQL 18 profile. It does not
qualify other engines or third-party extension hooks by extrapolation.

The fixture provisions two uniquely named databases, then writes two actual file-backed
migrations. Public migration planning independently replays both on the separate disposable
target; public apply creates the qualification schema and records history. A second plan has
no pending work. The migration declares the supported plpgsql environment and creates an ordinary
table plus a routine with an observable side effect if executed.

The fixture proves these environment boundaries before its final capture:

- A renamed/missing routine rejects reuse of the old native context while the table remains.
- Removing plpgsql and its dependent routine rejects the old context and migration drift checks.
- After restoring the migration-defined environment, a positive acquisition establishes a fresh
  control context. A separate connection with a different TimeZone rejects that context.
- An additional pgcrypto installation can be introspected, including its unnamed input and named
  table-output parameters, but native acquisition explicitly rejects the unqualified extension.

Final introspection and independently reconciled native capture use the restored database. The
routine's counter remains zero: qualification has not executed the application query. The fixture
exports the complete exact-query contract and closes native pools, waiting for actual client
removal acknowledgements before dropping both owned databases.

Only durable inputs then enter a separate installation of packed compiler, CLI, grammar and build
packages. The consumer removes PostgreSQL analysis, catalog and native modules and has no pg
driver. A preloaded Node guard rejects TCP connection, DNS and fetch attempts and verifies that
its connection trap is active; this is a Node-process check, not an OS network namespace.

The consumer runs frozen CLI checking, rejects an incompatible downstream TypeScript assignment,
bundles through the installed esbuild integration, imports the generated application and checks
its bigint parameter/result plan. It does not execute SQL. Direct frozen compilation reproduces
the captured output. Removing a required query artifact causes an explicit missing-input failure.

Local qualification passes on PostgreSQL 18.3 and Node 24.22.2 after a clean rebuild. The existing
PostgreSQL native/installed/live/cache/frozen proof also passes with the shared frozen consumer's
new actual bundling check. All 37 PostgreSQL files pass their coverage gate (97.28% statements,
90.30% branches, 97.99% functions), as do workspace types, nine soundness files, public API/package
graph, three packed-consumer/editor suites and documentation checks. The unnamed-parameter
provider regression fails before the codec correction and passes afterward.
Clean-tree quality and the isolated performance gate also pass.

The current PR review-thread read shows all 13 existing quality threads resolved and outdated;
this does not replace the final architecture acceptance audit.

Broader extension/engine profiles and representative project-size measurements remain open.

## PostgreSQL 18.6 namespace reproduction

CI run 42541625378 reached the migration fixture on PostgreSQL 18.6 but exposed an implicit
extension namespace assumption. Its role is named `typed_sql`; once the migration history schema
exists, the default `$user, public` path installs `pgcrypto` into `typed_sql`, while this fixture
explicitly introspects `public`. The fixture now installs that extension with `WITH SCHEMA public`.
No introspection filter or native extension admission boundary is widened.

The failure reproduces locally with a disposable PostgreSQL 18.6 instance and the same role name.
After the correction, the full helper passes through migration replay, extension/context rejection,
native reconciliation, durable export, removal of both qualification databases and the separate
packed/network-denied frozen consumer. The owned reproduction container is removed afterward.
