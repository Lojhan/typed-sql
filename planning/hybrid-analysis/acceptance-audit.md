# Architecture acceptance audit

This ledger checks the [22 required scenarios](./spec.md#23-required-acceptance-scenarios) against
the implementation, starting with source review at `3f4defff369904b4637840f4d6c69f5afb398114`
and the explicitly referenced subsequent regressions. It records evidence and remaining verification;
it is not a function-coverage percentage or a completion certificate.

**Scoped proof** means the referenced assertions establish the behavior within their declared
profile. **Partial** means a required part still lacks direct evidence. **Pending** means its
current required execution has not finished. A generic fixture or one native adapter never proves
all engine profiles. Unsupported facets/classes must remain explicitly unavailable.

The source review includes the actual assertions in the contract, cache, native-acquisition,
live-view, build, compiler and packed-consumer fixtures. Local checks for the latest implementation
pass build/types, package coverage, 49 repository contracts, soundness, documentation, quality and
isolated performance. [Preceding main CI](https://github.com/Lojhan/typed-sql/actions/runs/42555995580)
passes. [Main CI at `4fe65a4f`](https://github.com/Lojhan/typed-sql/actions/runs/42562791948)
also passes, including cold installed cores, source-move/inherited-grammar regressions, selected-core
commerce tooling and the reviewed SQL Server fingerprints. The subsequent partial-composition and
native-cost instrumentation changes, including the measurement-helper declaration, pass
[main CI at `310bd775`](https://github.com/Lojhan/typed-sql/actions/runs/42565964481).
The PostgreSQL/SQLite vocabulary milestone, including the compiler/editor fixture correction,
passes [main CI at `f0ffb78d`](https://github.com/Lojhan/typed-sql/actions/runs/42573680468).
This includes all six PostgreSQL native targets, SQLite keyword-API/context matrix checks and the
required source/editor/distribution gates. The optional MySQL canary native transport remains
unqualified. The MySQL vocabulary integration passes
[main CI at `8e050295`](https://github.com/Lojhan/typed-sql/actions/runs/42581926664), including
its required supported-engine native profiles. The optional canary remains unqualified.

| ID | Finding | Evidence and remaining boundary |
| --- | --- | --- |
| 1 | Scoped proof | All five grammar-owned `offline-core.test.ts` suites exercise fresh uncached queries and verify portable dependency graphs. The [cold packed consumer](../../test/helpers/cold-core-consumer.ts) discovers installed core exports for all five grammars, compiles a new parameterized query and runs each offline CLI in a fresh process with no durable inputs or analysis cache and no installed application driver. Node TCP/DNS/fetch traps load before compiler/core/config imports; local IPC is also denied and counted separately. Guard probes prove interception. Ordered bindings, known nullable results and absence of cache creation are asserted. This is a Node-process boundary, not an OS namespace or proof for arbitrary SQL. |
| 2 | Scoped proof | [PostgreSQL project catalog tests](../../packages/postgres/test/project-catalog.test.ts) and the [real native helper](../../test/helpers/postgres-native-contracts.ts) use selected fixed-scalar declarations for a different SQL statement without describing it again. Strictness, dependent/default/polymorphic metadata do not automatically grant fixed-result permission. This proves the qualified PostgreSQL mechanism, not universal reusable native rules for other grammars. |
| 3 | Scoped proof | [Contract consumer tests](../../packages/analysis/test/contracts.test.ts) assert empty columns, TSQ406 and unknown semantics for exact-text, schema, policy or repeated-shape mismatches. Each core's omitted-routine tests assert generation guidance and retained ordered parameters. [Frozen checking](../../packages/cli/test/frozen-check.test.ts) refuses missing durable inputs without analyzer/cache fallback. |
| 4 | Scoped proof | [Live sessions](../../packages/analysis/test/live-session.test.ts), [scheduler tests](../../packages/analysis/test/live.test.ts) and installed native helpers check refresh, tickets, runtime plans, source positions and candidate non-execution. The current SQL Server core/native and installed-host paths pass across all four engines; the reviewed catalog fingerprints pass in the latest pushed aggregate. |
| 5 | Scoped proof | [Cache tests](../../packages/analysis/test/cache.test.ts) reopen in another process, retain unverified freshness and reject known stale evidence. [Offline views](../../packages/analysis/test/offline-view.test.ts) let known negative evidence retire durable support instead of restoring it after disconnection. Real installed helpers exercise cache-only restart and offline reuse. |
| 6 | Scoped proof | [Isolated frozen consumers](../../test/helpers/frozen-contract-consumer.ts) remove analysis/catalog/native modules and drivers, consume only durable closure inputs, run frozen CLI/build/TypeScript/runtime-plan checks and reject deletion of a required query object. Node TCP/DNS/fetch traps are active before loading the consumer. This is a Node-process network boundary, not an OS namespace. |
| 7 | Scoped proof | The [real PostgreSQL helper](../../test/helpers/postgres-native-contracts.ts) physically renames a query source into a subdirectory, adds leading lines, re-extracts identical SQL/bindings, reopens the cache and exports/reloads the same qualified contract digest with unverified freshness. Offline compilation has no native adapter and retains row/parameter/decoder plans while query and missing-contract diagnostic spans follow the new source positions. [Candidate extraction](../../packages/compiler/test/candidates.test.ts) covers finite variants/bounds; [manifests](../../packages/compiler/test/manifest.test.ts) cover checkout-root independence and [live scheduling](../../packages/analysis/test/live.test.ts) fences old documents. This proves semantic reuse and regenerated spans, not arbitrary editor filesystem watcher behavior. |
| 8 | Partial | Context and owner identity changes are rejected in [project catalogs](../../packages/analysis/test/project-catalog.test.ts), [offline views](../../packages/analysis/test/offline-view.test.ts) and native helpers. Migration and table probes mutate routines/extensions/settings and guard DDL. The [per-profile invalidation matrix](./context-invalidation.md) now records actual PostgreSQL principal/grant/search-path/time-zone mutations and real decoding-policy isolation on PostgreSQL, MySQL, SQLite and both DuckDB engines. SQL Server permission and codec mutation controls pass all ten hosted pairs in [run 42597621667](https://github.com/Lojhan/typed-sql/actions/runs/42597621667). MySQL direct/role grants, principal, database and semantic-setting changes pass locally on both supported engines. Other applicable authorization/settings/engine replacement mutations remain open; field presence alone is insufficient. |
| 9 | Scoped proof | [Native acquisition](../../packages/analysis/test/native-contracts.test.ts) guards before/after context and refuses inconsistent evidence. [Catalog capture](../../packages/analysis/test/live-catalog.test.ts) verifies classified guard drift, real cache retirement, bounded recapture and owned cleanup. Native table/profile probes use declared whole-context guards where dependency isolation is unknown. |
| 10 | Scoped proof | [Reconciliation](../../packages/analysis/test/reconciliation.test.ts) rejects contradictory static/native facts. [Native descriptors](../../packages/analysis/test/native-contracts.test.ts) preserve unknown facets and reject plan/evidence disagreement. SQLite's real unmapped-routine test retains incomplete storage-class identity and refuses a required precise native type. Runtime decoder policy tests reject incompatible plans rather than coercing them optimistically. |
| 11 | Scoped proof | [Candidates](../../packages/compiler/test/candidates.test.ts), [native-value compilation](../../packages/compiler/test/native-values.test.ts), [value plans](../../packages/compiler/test/value-plan.test.ts) and grammar tests retain ordered/repeated bindings and finite branches. Metadata permissions preserve named/default/table-output declarations without generalizing one description into a family. Unqualified statement/parameter classes remain diagnostic. |
| 12 | Scoped proof | [Candidate extraction](../../packages/compiler/test/candidates.test.ts) refuses dynamic/unbounded structural rendering. [SQLite native tests](../../packages/sqlite/test/native-contracts.test.ts) exercise static syntax unavailable to the parser only through authorizer-owned preparation and reject writes, external access and unregistered routines. Other adapters retain narrower explicit acceptance scopes. |
| 13 | Scoped proof | The [composed PostgreSQL project test](../../packages/postgres/test/project-catalog.test.ts) selects/interprets a fixed project routine through the 18 core in a subquery, CTE and compound, acquires independent controlled protocol evidence, reconciles and serializes/reloads its exact contract, builds/round-trips a manifest and collects/verifies candidates. Partial numeric identities remain partial in columns and parameters; unknown nullability remains nullable. Requiring exact native identity returns incomplete, and known type conflicts still produce mismatches. A contract alone keeps execution effects unknown and verification stays cold; a separate pass uses the independently computed core operation and skips incomplete metadata. This proves pipeline mechanics with a protocol fixture; actual engine statement admission remains bounded by its adapter. |
| 14 | Scoped proof | [Frozen CLI checks](../../packages/cli/test/frozen-check.test.ts) keep registered factories cold; [native acquisition](../../packages/analysis/test/native-contracts.test.ts) rejects malformed inputs before opening services. Cache tests exclude SQL/source values from persisted objects. Scheduler/session tests enforce workspace/target identity, limits, cancellation and late-resource cleanup. |
| 15 | Scoped proof | [Cache tests](../../packages/analysis/test/cache.test.ts) exercise real process writers/pruning, interrupted publication, ownership namespaces, corrupt/oversized objects, locks and unrelated-file preservation. [Durable closure tests](../../packages/analysis/test/contracts.test.ts) reject conflicting, swapped, missing and partially published artifact generations. |
| 16 | Scoped proof | [Build integration](../../packages/build/test/build.test.ts) keeps analyzer/native factories cold for frozen builds and uses offline rules in ordinary live-configured builds. Explicit live preparation is separate. Canonical manifests/closures and isolated consumers check path-independent, cache-independent output; timestamps remain disposable freshness evidence. |
| 17 | Partial | Five grammar profiles use neutral orchestration; [synthetic vendor contracts](../../packages/analysis/test/contracts.test.ts) compile/decode without builtin analyzers. A [derived grammar contribution](../../packages/analysis/test/helpers/inherited-postgres.ts) uses public entrypoints exclusively to inherit PostgreSQL 18 rendering, policy, analyzer, native transport and reconciliation mechanics under its own snapshot/profile/interpreter identities. Its [unit tests](../../packages/analysis/test/inherited-grammar.test.ts) enforce cold registration, identity/version checks and retained restrictions; the [real integration](../../test/helpers/inherited-postgres-contracts.ts) qualifies an unknown routine, persists/reopens its cache, exports durable inputs, compiles offline and decodes with the child identity. It retains unknown nullability and does not inherit reusable catalog permissions. The [observed facet table](./native-costs.md#observed-native-facets) now includes all 16 measured profiles, including ten hosted SQL Server pairs. It records invocation-specific descriptors and complete/partial/unknown evidence; this representative fixture table does not establish every type-family capability. The remaining descriptor-family review stays open. |
| 18 | Scoped proof | [Frozen packed consumers](../../test/helpers/frozen-contract-consumer.ts) actually delete semantic/native files and decode through lightweight runtime entrypoints. [Bundle measurements](./bundle-size.md) retain zero global catalogs in runtime/profile/frozen graphs, isolate optional/version imports and separate package installation from tree-shaken bytes. |
| 19 | Partial | [Main CI at `4fe65a4f`](https://github.com/Lojhan/typed-sql/actions/runs/42562791948) is green, including reviewed catalog fingerprints, cold cores, native execution and source quality/performance. [Main CI at `310bd775`](https://github.com/Lojhan/typed-sql/actions/runs/42565964481) also passes after adding the measurement-helper declaration. [Main CI at `f0ffb78d`](https://github.com/Lojhan/typed-sql/actions/runs/42573680468) passes PostgreSQL/SQLite vocabulary integration and the alias fixture correction. The MySQL vocabulary milestone passes [main CI at `8e050295`](https://github.com/Lojhan/typed-sql/actions/runs/42581926664). The audit-only [DuckDB run at `a05f4daf`](https://github.com/Lojhan/typed-sql/actions/runs/42583640548) fails its compiler semantic-metadata performance budget (20.85 ms / 20 ms), despite passing native jobs. The parser integration passes [main CI at `a1673bbb`](https://github.com/Lojhan/typed-sql/actions/runs/42585766197), including unchanged performance budgets. New SQL Server source/native audit changes require their own hosted aggregate; no budget is increased. MySQL local recognition/context differences remain disclosed without local baseline acceptance. The [full run at `8328c51f`](https://github.com/Lojhan/typed-sql/actions/runs/42599873360) passes every required gate, including PostgreSQL 18.6, supported MySQL profiles, all SQL Server engines and unchanged hosted performance budgets; the optional MySQL canary remains unqualified. Subsequent audit-only changes require their own current-head run. No timeout or budget increase substitutes for a fix. |
| 20 | Scoped proof | [Reconciliation tests](../../packages/analysis/test/reconciliation.test.ts) explicitly block an apparently successful wrong mapping. [Live view tests](../../packages/analysis/test/live-view.test.ts) qualify every unique successful static candidate, persist conflicts and re-describe during explicit live checking rather than substituting a prior cached contract. |
| 21 | Scoped proof | [Migration qualification](../../test/helpers/migration-contracts.ts) applies/replays file-backed PostgreSQL migrations, rejects missing routines/extensions and changed settings despite matching tables, exports durable reconciled inputs, drops qualification databases and invokes the separate packed network-trapped frozen consumer. This qualifies PostgreSQL 18's declared environment, not every migration/extension/engine combination. |
| 22 | Partial | [Bundle](./bundle-size.md), [repository](./repository-size.md), [installation](./installation-measurements.json) and [commerce project](./project-size.md) reports measure distinct costs. Installation is refreshed at this audit's source. The commerce tool now discovers matching public core exports and independently compares all 37 finite base candidates with the compatibility analyzers: complete analyses and measured payloads are identical. These are selected example profiles, not production popularity or all versions. The [native cost report](./native-costs.md) now measures 16 actual owner-fixture profiles across all five grammars, including all ten hosted SQL Server compatibility targets. It separates schema, plan, reconciled closure and cache bytes plus context/acquisition/reconciliation/reload/cold/warm timings. The [automated commerce admission audit](./native-admission.md) now executes every discovered owner prefilter against all 37 finite maintained candidates under network denial: six are admitted, 24 declined and seven unavailable because the example lacks native environment evidence. All have zero core analysis errors. Admission is explicitly not native qualification; actual schema provisioning, reconciliation and scaling beyond the one-query fixtures remain open. |

## Cross-cutting requirements still requiring proof

The [native facet table](./native-costs.md#observed-native-facets) now retains validated
column/parameter evidence from six actual local profiles: PostgreSQL 18.3, MySQL 8.4.11/9.7.2,
DuckDB 1.5.6/2.0.0 and SQLite 3.53.4. It explicitly distinguishes complete, partial, unknown,
absent fixture parameters and older observations without recorded facets. All ten hosted SQL
Server facet records now come from the passing [focused run](https://github.com/Lojhan/typed-sql/actions/runs/42597621667), with recorded stable-context attempts and successful cleanup. This evidence does not close scenario 8's mutation
matrix or establish availability beyond the measured invocations.

- **Offline vocabulary:** PostgreSQL now consumes hash-pinned source declarations for all six
  selected majors, factored into shared rows and version deltas. Generated tests cover complete
  keyword classes, bare labels, qualified columns and relation/CTE identifiers; the PostgreSQL E2E
  matrix also compares the inventory against `pg_get_keywords()` and non-executing native probes.
  PostgreSQL native evidence also covers all six hosted matrix versions. SQLite now consumes
  source-derived build guards, fallback/name/alias classes and contextual lexer rules across 19
  pinned profiles covering every supported minor boundary. Local SQLite 3.39.0 and 3.54.1 C APIs
  exactly match the active inventory, and generated context probes pass there and on Node
  SQLite 3.53.4. The CLI matrix fails its separate reviewed-context gate for the local compiler;
  those new local contexts are not accepted as standard baselines. Hosted SQLite matrix qualification
  passes at `f0ffb78d`. MySQL now consumes three pinned source profiles and a compact runtime
  projection; native inventories and identifier/function binding probes pass locally on 8.4.11
  and 9.7.2. The function namespace preserves quoting, whitespace and IGNORE_SPACE distinctions
  instead of assuming that every matching spelling is the same built-in. Required MySQL hosted
  qualification passes at `8e050295`; the canary remains unqualified. DuckDB now has independent
  pinned Yacc/PEG declarations and complete native inventory/context checks on 1.5.6 and 2.0,
  retaining overlapping classes and the version-specific bare-label subset. Its selected full/core
  parsers now consume those declarations and pass the same 7,928 cases locally. Both engines
  also independently qualify 991 versioned expression labels, with selected-core name/type
  assertions. DuckDB integration passes [main CI at `a1673bbb`](https://github.com/Lojhan/typed-sql/actions/runs/42585766197).
  SQL Server now has pinned source token/context declarations for four engines and a generated
  native description audit across all ten compatibility pairs. The `24cbc659` artifacts complete
  all 151,120 cases and expose three shared source deltas plus a 17/170 reservation delta;
  reviewed policy data retains those differences and all provenance. The stricter native reader
  passes all four engine jobs in [run 42592102996](https://github.com/Lojhan/typed-sql/actions/runs/42592102996),
  covering all ten compatibility pairs. That aggregate fails source quality at a cancelled live
  catalog test's directory cleanup; the optional MySQL canary also remains unqualified.
  Host parser consumption now passes all 151,120 generated identifier-context cases locally,
  plus 18,890 quoted-column type/nullability checks through the selected core. Analyzer checks
  verify actual engine selection, reserved-word diagnostics and ordered parameter evidence.
  The session shutdown fix drains pending context cache publication and has a deterministic
  cancellation-during-publication regression. Fresh aggregate qualification is still required. This audit
  has not established that every grammar/profile's
  complete authoritative reservation/context inventory is generated and consumed correctly.
  Verify inventory-to-parser classification and quoted/unquoted contextual behavior before
  claiming specification section 3 is complete. Do not equate a discovered word with syntax support.
- **Core selection:** current distribution retains compatibility and has measured size evidence.
  The maintained application corpus now runs against discovered selected-core exports: all 37
  finite candidates have identical complete compatibility analyses and need no native generation;
  unbounded rendering remains excluded from exact contracts. The report records example version
  evidence and sampling limits. This does not establish production function popularity or all-version
  workload behavior.
- **Reusable metadata:** the project layer is optional, but its exact supported permission/type
  scope must be published per owner. PostgreSQL fixed scalars do not imply portable polymorphic,
  custom-type, table-output or argument-dependent rules.
- **Measurement closure:** native-qualified single-query fixtures now have actual byte and
  context/acquisition/cache observations for 16 profiles across all five grammars. Their small
  schema inputs and three observations are not a complete native application scaling result.
  The maintained commerce corpus still supplies the separate realistic offline project measure.
  Installation, external drivers/engines and minified application bundles remain separate costs.

The remaining implementation sequence is concrete: establish generated vocabulary scope;
account for native application-workload admissibility/scaling; reconcile
descriptor/invalidation/profile evidence; then run the full required gates.
This ledger deliberately leaves those requirements open instead of deriving completion from test
counts, native preparation alone, or a narrow successful sample.
