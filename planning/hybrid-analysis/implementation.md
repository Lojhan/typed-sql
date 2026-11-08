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

The exhaustive upstream inventory, vendor fact extraction, global catalog model, generated
completeness reports and selected-version/core/compatibility-pack APIs are excluded. Normal
builds and installations do not fetch database sources or require a global engine inventory.
The existing PostgreSQL/MySQL catalog generators also derive small runtime codec projections
from their maintained catalog inputs, preserving compile-time/runtime policy agreement.

## Qualification limits

PostgreSQL native acquisition is restricted to the documented expression-query profile.
The other four grammars retain their existing offline support and contract-profile interfaces;
they do not acquire broader native query-description qualification from this change.
Project routine catalogs and workload-selected offline packs remain later work.

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
