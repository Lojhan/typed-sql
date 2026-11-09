# Query-contract implementation evidence

PR [#280](https://github.com/Lojhan/typed-sql/pull/280) implements the architecture in
[the specification](./spec.md): bounded offline grammar semantics, qualified project declarations,
exact-query contracts, persistent offline reuse and explicitly configured live regeneration.
The [acceptance audit](./acceptance-audit.md) owns requirement-by-requirement evidence and open gates.
Its scoped proofs are not a percentage of SQL syntax, functions or real-world workload coverage.

## Repository and distribution

- `packages/analysis` owns neutral evidence, reconciliation, context identities, durable closures,
  persistent caching and bounded live scheduling. It does not choose SQL semantics.
- Grammar packages own offline cores, optional compatibility packs, native admission,
  descriptor interpretation and reconciliation contributions. Optional driver adapters are explicit.
- The compiler, CLI, build integrations and language server consume the shared orchestration.
  Application imports remain grammar-owned `sql` entrypoints.
- `.typed-sql/cache/analysis` is disposable development evidence. Durable exported inputs are
  separate, reviewable project artifacts. Ordinary build hooks use durable inputs and make no
  database calls; frozen checking does not depend on the development cache.
- Runtime consumers carry rendering, binding and codec requirements. Profiles, analyzers, native
  adapters and unrelated grammar packs remain outside the checked runtime import graphs.

The exhaustive generated routine inventory and vendor source corpus have been removed. Compact
hash-pinned keyword/context projections and descriptor audit witnesses remain. Normal installation
and builds do not fetch engine sources or require a global engine catalog. Existing small
PostgreSQL/MySQL runtime codec projections preserve inference/decoding policy agreement.

## Qualified native scope

| Owner | Exact tested native profiles | Boundary and evidence |
| --- | --- | --- |
| PostgreSQL | 18.3 and 18.6 guarded native contract profiles; separate vocabulary/protocol observations span the selected major matrix | [Native proof](./postgres-native-proof.md). Checked permanent scalar-column heap tables and supported SELECT expressions; custom/enum/composite/range/multirange table columns fail admission. Catalog declarations permit selected fixed scalar routines, not universal invocation rules. |
| MySQL | 8.4.11 and 9.7.2, including the declared SQL-mode matrix | [Native proof](./mysql-native-proof.md). Owned backup-locked sessions, guarded SELECT/table metadata and independent protocol evidence. Unsupported constructors, incomplete parameter metadata and canary results remain explicit. |
| SQLite | Node advanced-API profiles using SQLite 3.53.4 and 3.54.0 | [Codec proof](./sqlite-codec-proof.md). Read-only preparation, authorizer/origin evidence and four audited decoding policies. Storage-domain evidence does not prove arbitrary expression types; older APIs report native acquisition unavailable. |
| DuckDB | Node SDK engines 1.5.6 and 2.0.0 | [Native proof](./duckdb-native-proof.md). Guarded supported projections/table metadata, SDK descriptor interpretation and independent reconciliation. Unsupported nested/custom/extension combinations do not gain types from their names. |
| SQL Server | Four pinned engines, major 14–17, across ten declared compatibility pairs | [Native proof](./sqlserver-native-proof.md), [table proof](./sqlserver-table-proof.md). Guarded static rendering, independently described input/output metadata and qualified execution policies. Unsupported statement classes, opaque/custom table columns and insufficient parameter evidence remain diagnosed. |

The [descriptor-family audit](./descriptor-families.md) accounts for independently discovered names,
constructors, input/output observations and complete/partial/unavailable facets. The shared facet
summarizer has no grammar/type-name allowlist; its state classification is checked against the
qualification model. [Context invalidation](./context-invalidation.md) records actual authorization,
session, schema, routine, engine and codec boundaries and their explicitly unqualified cases.
These finite profiles do not establish every extension, type modifier, query composition or policy.

## Reusable metadata and query evidence

PostgreSQL project catalog capture selects complete overload families from project SQL and retains
raw parameter/default declarations and provenance. Qualified fixed scalar declarations can support
another invocation offline. Polymorphic, variadic, default-dependent, decimal-dependent and table
results require their own qualified evidence. Other owners do not inherit PostgreSQL permissions.

Exact-query contracts preserve ordered parameters, result plans, context/policy identities and
facet uncertainty. Native/static conflicts block publication, even when the offline rule appears
successful. Unknown nullability remains conservative; broad JSON and custom types do not acquire
an invented structure. Dynamic or unsupported SQL fails closed.

Live mode is explicitly configured and request-driven. Shared sessions observe context, bound work,
coalesce requests and retain qualified evidence for offline reuse. Context changes retire old
proofs. Classified observation/acquisition drift has finite retries within the original deadline;
explicit context pins, permission failures and unsupported statements are not silently retried into
acceptance. Cancellation, shutdown, publication fences and queue limits remain enforced.

A regression found during SQL Server packed-editor investigation showed that a refreshed session
could return completed in-memory evidence after its persistent cache was cleared or retired. The
scheduler now advances its context generation when a successfully observed publication fence changes,
including when the database context identity is restored unchanged. Its previous producers/results
cannot serve new tickets. The regression clears and retires through independent cache handles,
requires fresh acquisition, keeps old views invalid, closes the live session and analyzes offline
with no durable contracts and an analyzer-loading trap. A second regression settles old pending
preparations when their scheduler generation is replaced, without waiting for their deadline.
The packed SQL Server editor fixture revisits its original query live after the changed-query
check before testing that same query offline; an intervening observed drift can legitimately
retire its earlier proof. Hosted qualification remains required.

## Evidence review and cache maintenance

The full specification audit found three user-facing gaps beyond the scenario checklist. The CLI
now provides read-only `cache status` and owned `cache prune` commands; status includes indexed
outcomes/failure codes, contexts and query/catalog selections missing from durable export. It
explicitly cannot observe other processes' active requests. Read-only inspection does not create
storage or invoke native/analyzer/provider factories.

Query generation now reports semantic query/declaration changes. `--json` retains complete old/new
facts, ordered parameters, native evidence, decoding policy, qualification, unresolved facets and
current source callers. Check-only differences preserve durable files. Exact SQL changes remain
removal/addition; review does not invent an equivalence or grant inference permissions.

Template and SQL-file hovers now identify evidence origin and recorded context with unverified
remote freshness. Focused and complete CLI/editor suites, public API/packed contracts, root types,
build, documentation, analysis coverage, quality and isolated unchanged performance checks pass.
The [full completion audit](./completion-audit.md) retains the native-pending diagnostic host check
and fresh hosted qualification as open requirements.

## Measurements and workload limits

The canonical reports distinguish costs rather than combining generated inputs with application
runtime code:

- [Repository LOC](./repository-size.md): maintained package code, generated code, tests, tooling,
  compact audit data and documentation, compared with the base and discarded exhaustive pipeline.
- [Bundles](./bundle-size.md): minified, gzip and Brotli sizes and attributed input modules for
  runtime, profiles, cores, compatibility paths and disconnected consumers.
- [Installation](./installation-measurements.json): packed package bytes and optional native costs.
- [Project growth](./project-size.md): separate schema, query-plan, declaration and runtime costs
  for the maintained finite commerce corpus at three scales.
- [Native fixture costs](./native-costs.md) and [actual native projects](./native-projects.md):
  qualified subsets, rejection/unavailability reasons, timing and disconnected replay across
  sixteen owner profiles. The offline commerce result is not native statement admission.

Bundle, repository, installation and project reports now share committed production source
`2e100286aee1853b30047721638437e843027a33`, including cache maintenance, export diffs and hover evidence. The isolated
performance gate also passes with unchanged budgets. Each report identifies its committed producer. A later source change needs refreshed measurements
before its results can be called the final after-results. Root quality checks rendered tables
against their JSON. Measured example coverage is not a production-popularity estimate.

## Verification and remaining gate

The [acceptance audit](./acceptance-audit.md) retains 21 scoped proofs and one partial integration
gate. The first attempt of [run 42664684022](https://github.com/Lojhan/typed-sql/actions/runs/42664684022)
passes the required aggregate, but a repeat fails SQL Server 17's cache-only SQL editor with a
missing exact contract. A passing attempt does not resolve that intermittent failure. The local
scheduler persistence regression is fixed; its relationship to that hosted failure must be verified.
Local validation of the fix passes analysis coverage (98.56% statements, 93.54% branches,
99.47% functions), root typechecking, build, all sixteen language-server files and all fifty-four
repository contract files. The complete PostgreSQL 18.6 E2E command passes its standalone
typecheck and both native/developer files in 118.05 seconds. The editor suite is run after the
PostgreSQL fixture completes because both use its generated schema. No timeout or performance
budget increase substitutes for a fix.

Previous implementation notes were chronological and contained superseded pending claims. Their
[historical evidence remains available at the prior commit](https://github.com/Lojhan/typed-sql/blob/ff4588747cb14de2f39cd1a7b6efcb7538f2cee2/planning/hybrid-analysis/implementation.md).
Current scoped claims and source links live in the acceptance, descriptor and context ledgers above.
