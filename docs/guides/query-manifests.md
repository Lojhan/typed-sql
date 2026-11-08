---
title: Query manifests
pageType: how-to
description: Emit deterministic, secret-free query metadata for CI, deployment checks, and production correlation.
---

# Query manifests

A query manifest turns compiler analysis into a versioned JSON artifact. It records every statically visible query, its bounded structural variants, inferred parameters and results, semantic dependencies, capabilities, diagnostics, and observation fingerprints.

The same artifact is the offline input to [live verification](./live-verification.md), which compares compiler evidence with native database prepare metadata and writes a separate secret-free proof.

Application code does not import the manifest. Queries use the selected grammar’s `sql` tag or a [SQL-file factory](./sql-files.md). For example:

<LiveQueryExample dialect="postgres" filename="src/queries.ts">
<template #source>

```ts
import { sql } from "@typed-sql/postgres";

export const account = sql`
  SELECT users.id, users.email
  FROM users
  WHERE users.id = ${42n}
`;
```

</template>
</LiveQueryExample>

## Configure the output

List the TypeScript projects that contain queries and optionally select an output path:

```ts
import { defineConfig } from "@typed-sql/core";
import { typePolicy } from "@typed-sql/postgres"; import { postgres } from "@typed-sql/postgres/analysis";

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: { file: "src/generated/db/schema.json" },
  outDir: "src/generated/db",
  projects: ["tsconfig.json", "packages/jobs/tsconfig.json"],
  manifest: {
    outFile: ".typed-sql/queries.json",
  },
  typePolicy,
});
```

Generate the artifact:

```sh
pnpm exec typed-sql manifest
```

`--project` analyzes one explicit tsconfig instead of the configured project list. `--out` overrides the configured output path.

The command asks the workspace TypeScript executable for the files selected by each tsconfig. SQL parsing and inference still run through the grammar-neutral typed-sql compiler and the configured dialect; the compiler package does not depend on TypeScript preview APIs.

## Imported SQL files

Literal relative or absolute `.sql` imports and re-exports in the configured TypeScript source graph
are included alongside inline templates. A missing imported SQL file fails discovery; unrelated
migration scripts are not collected. Package aliases and computed paths are not discovery routes.

Named and repeated bindings are analyzed through the same frontend as their generated factories.
Manifest parameter descriptions follow the expanded SQL occurrence order, which can differ from
the factory's logical argument order. SQL-file locations and dependency spans refer to the original
source, and each asset's content hash participates in stale-proof rejection.

See [SQL files and application identities](../examples/sql-files-and-identities.md) for a complete
example and its verification, plan, and migration-compatibility workflows.

## Artifact contents

Format version 1 contains:

- the compiler version, dialect id, grammar version, fingerprint algorithm, schema format, canonical schema hash, and type-policy hash;
- a capability fingerprint used to invalidate incremental analysis when normalized server evidence changes;
- checkout-relative project and source paths plus content hashes for incremental reuse;
- one source-located entry for each static query or explicit `sql.dynamic()` escape hatch;
- a resolved query's aggregate fingerprint, structural variants, hashed branch choices, row and parameter literals, column and parameter descriptions, and semantic evidence;
- exact, conservative, or unsupported capability evidence only for declared capabilities used by that query or structural variant;
- an unresolved query's diagnostic codes, severities, source ranges, and either `diagnostic` or `dynamic` reason.

Each structural query remains one manifest entry. Its bounded variants are nested under that entry instead of duplicating the source query. Variant fingerprints match the identities emitted by runtime observation, allowing telemetry to correlate with compiler evidence without recording SQL text.

Entries are sorted by relative file and source position. Object keys use canonical order, so unchanged inputs produce byte-identical output even when a checkout moves to another absolute directory.

## Security boundary

The manifest never serializes:

- absolute paths;
- database URLs or connection configuration;
- runtime parameter values;
- environment values;
- SQL source text.

It does contain relative source paths, database object names, TypeScript type descriptions, diagnostic codes, and semantic classifications with source ranges. Human-readable grammar diagnostic messages, fixes, branch expressions, and evidence descriptions are deliberately excluded because third-party grammars may derive them from source text. Treat the remaining fields as application metadata and apply the same artifact access policy used for source maps or build reports.

Static SQL literals influence fingerprints but are not reversible from their SHA-256 digest. A fingerprint is an identity for correlation, not a security signature.

## Unresolved queries and exit codes

The manifest is written even when it contains unresolved entries. This makes unsupported or intentionally dynamic work visible rather than silently omitting it.

| Exit code | Meaning |
| ---: | --- |
| `0` | The manifest was written and every entry resolved. |
| `2` | The manifest was written and contains one or more unresolved entries. |
| `1` | Configuration, project discovery, schema loading, or artifact generation failed. |

A CI job can decide whether unresolved entries are permitted while always retaining the produced artifact:

```sh
set +e
pnpm exec typed-sql manifest --out artifacts/typed-sql-queries.json
status=$?
set -e

if [ "$status" -eq 1 ]; then
  exit 1
fi
```

Projects that commit the manifest can additionally run `git diff --exit-code -- .typed-sql/queries.json`. Projects that do not commit it can upload the file as a build artifact for deployment verification or production correlation.

## Incremental generation

When the output file already contains a compatible manifest, generation reuses entries for source
files whose content hash is unchanged. A compiler, format, fingerprint algorithm, dialect, grammar,
schema format, schema content, type-policy, or resolved-capability change invalidates reuse conservatively. This includes
relevant server versions, settings, extensions, and compile options recorded by the snapshot.

The production performance gate measures both a full 250-query build and an unchanged incremental build. See [Performance](../concepts/performance.md) for the current regression budgets.

## Programmatic API

`@typed-sql/compiler` exports:

- `buildQueryManifest(options)` for in-memory source inputs and optional previous-manifest reuse;
- `serializeQueryManifest(manifest)` for canonical JSON;
- `parseQueryManifest(value)` for compatible reader validation;
- `listProjectSourceFiles(options)` for tsconfig file enumeration;
- `QUERY_MANIFEST_FORMAT_VERSION`, `QUERY_FINGERPRINT_ALGORITHM`, and `QUERY_MANIFEST_JSON_SCHEMA` for consumers.

Format readers accept additive object properties within format version 1. An incompatible required-field or meaning change increments `formatVersion`. A documented fingerprint normalization change uses a new `fingerprintAlgorithm`. Consumers must reject unsupported format or fingerprint versions instead of interpreting them optimistically.


## Consume durable query contracts in a compiler host

`@typed-sql/analysis` provides a programmatic contract format for compiler integrations.
A query contract binds exact rendered SQL to a grammar/profile, schema, database context,
decoding policy, codec revision and interpreter revision. Its application types derive from
validated runtime value descriptors. It does not contain executable TypeScript or application
parameter values.

Compiler hosts can persist an explicit input set with `exportQueryContracts(directory, contracts)`
and reload it with `loadQueryContracts(directory)`. The directory contains a content-addressed
`contexts/` and `queries/` tree and an atomic `manifest.json`. Only objects listed in that manifest
are inputs. Missing, corrupt or conflicting objects fail loading; old unreferenced objects do
not supply missing support. Exporting a replacement set publishes a new manifest and retains
old objects. This API does not prune them.

Pass the loaded contracts, their expected `QueryContractContext`, and a lightweight grammar
profile to `createContractDialect`. The profile supplies rendering, snapshot validation and
policy information without an `analyze` implementation. The returned dialect can be passed to
existing compiler APIs. A matching contract supplies ordered parameter descriptors, result
columns and the runtime value plan. A SQL, schema or policy mismatch produces `TSQ406`.
Repeated fragments require additional invariance evidence and are conservatively rejected.
Execution effects and cardinality remain unknown.

Each built-in grammar exposes a driver-free `/profile` entrypoint:

| Grammar | Import | Factory |
| --- | --- | --- |
| PostgreSQL | `@typed-sql/postgres/profile` | `postgresProfile()` |
| MySQL | `@typed-sql/mysql/profile` | `mysqlProfile()` |
| SQLite | `@typed-sql/sqlite/profile` | `sqliteProfile()` |
| SQL Server | `@typed-sql/sqlserver/profile` | `sqlserverProfile()` |
| DuckDB | `@typed-sql/duckdb/profile` | `duckdbProfile()` |

Profiles provide grammar mechanics without constructing an analyzer or loading semantic routine
catalogs and introspection providers. They contain no analyzer loader. A development host registers
its analyzer contribution separately. DuckDB retains its syntax parser for contextual parameter
extraction: a struct field separator or slice colon must not become a named parameter.

These APIs consume previously established evidence. Setting a contract's `origin` does not
perform native qualification or prove that an engine supplied it. Contract digests detect
inconsistent contents; they do not authenticate the producer. Use reviewed compiler inputs
from a trusted generator. Application code continues using its grammar's `sql` tag.

### Selected project catalog inputs

A compiler host can bind selected catalog declarations to its query-contract export with
`createProjectCatalogClosure({ schema, context, typePolicy, catalogs, contributions })`.
The closure records the base context, selected catalog metadata and resulting context.
Applying a catalog can change both the schema and profile hashes; it does not replace the
base identity or prove freshness of the remote database.

Pass the closure as `selection.projectCatalogs` to `exportQueryContracts`, together with the
base target `scope` and the closure's resulting `context`. The resulting version 2 manifest
publishes `catalogs/`, context and query objects through the same atomic commit. Exports without
catalogs retain manifest version 1. Missing or changed catalog objects fail loading and are
included in `loadQueryContractInputs().files` for build dependencies and watching.

`materializeProjectCatalogClosure` requires the original schema, type policy and independently
installed grammar contributions. It recomputes the enriched schema and rejects an incompatible
interpreter or stored result. `loadFrozenContractView` accepts those contributions through
`projectCatalogContributions` and returns the resulting `schema` alongside its dialect. Compile
using that schema; the base schema cannot stand in for an enriched compiler input. Without the
required interpreters, frozen loading fails explicitly.

Register interpreters in configuration through `analysis.projectCatalogs.loadContributions`.
For PostgreSQL selected routine declarations, assign this object to `analysis.projectCatalogs`:

```ts
const projectCatalogs = {
  async loadContributions() {
    const { createPostgresProjectCatalogContribution } =
      await import("@typed-sql/postgres/project-catalog");
    return [createPostgresProjectCatalogContribution()];
  },
};
```

The CLI, build integrations and editor load this factory only when selected catalog inputs require
it. Interpreters must be deterministic and offline; native acquisition belongs to the separate
live adapter. Offline checks can analyze uncovered queries against the enriched schema, while
frozen checks require an exact query contract. Builds consume durable catalog inputs without
opening the development cache or native services. Editors track both the catalog objects and
local interpreter dependencies. A known retired base context blocks offline reuse of its derived
catalog, even if a target head was never published; frozen builds remain independent of that
disposable cache. Catalog acquisition and automatic live refresh remain separate from this
recorded-input registration.


### Acquire evidence through an explicit adapter

Compiler hosts can call `acquireNativeQueryContract` with a `NativeContractAdapter`, the expected
context and a static candidate. Candidates contain SQL, every placeholder occurrence and optional
SQL-relative result spans. They contain no application values. The grammar owner accepts only
statement classes and binding behavior it can safely describe before opening a session.

The session supplies context identities and a native description under a declared snapshot or
qualified guard. Acquisition compares context before and after description, snapshots caller
inputs before awaiting, checks adapter identity and parameter layout, and closes the session on
success, failure or cancellation. A changed context or unavailable parameter identity prevents
contract acquisition. The session owner remains responsible for the consistency guarantee;
before/after equality alone cannot establish an engine's snapshot semantics.

Native evidence records sanitized descriptors and known/unknown facts separately for native
identity, runtime representation and nullability. Unknown nullability projects to a nullable
application type. A known SQL family with incomplete modifiers remains partial when consumed.
Unknown result representations remain `unknown`. Contract loading validates that evidence and
the runtime value plan agree. A lightweight profile must establish the same placeholder layout
before consuming a parameterized native contract.

This acquisition API is separate from [live verification](./live-verification.md): it does not
require a resolved compiler claim. Adapter implementations and hosts must supply their qualified
context, statement acceptance and descriptor interpretation. Calling the API does not activate
background refresh or change ordinary build network behavior.

### Reconcile independent static claims

`createStaticQueryClaim({ sql, context, analysis })` captures ordered fields and diagnostic codes
from a separate offline analysis. It excludes source paths and diagnostic messages.
`reconcileQueryContract` compares that claim with a fresh native contract through an explicitly
selected grammar contribution and `ContractQualificationPolicy`. It checks SQL/context identity,
contribution identity/version/grammar, result kind, ordered labels and parameter counts, then
invokes grammar-owned comparisons for type and nullability facts. Successful offline analysis
is compared too; it is not accepted as native proof by itself.

The result has one of three statuses:

- `qualified` supplies a contract with a validated qualification report.
- `conflict` supplies a report and no contract because known claims disagree.
- `incomplete` supplies a report and no contract because a required native facet or comparison
  is unavailable.

The report distinguishes compatibility, conservative widening and unavailable facts. Native
nullability records whether a known bound is exact or an upper bound. An upper bound that includes
NULL does not refute a static non-null refinement. Unknown nullability does not confirm it.
Published descriptors use the conservative native plan, so they can be wider than offline types.

A successful proof binds the native evidence, original native contract, static claim digest,
comparison owner and normalized policy. Persist it through the ordinary contract export API.
Set `qualificationPolicyHash` on `createContractDialect` to the digest of the configured policy
returned by `parseContractQualificationPolicy`. Calculate that expected hash from configuration;
do not accept a policy merely because its hash appears in an artifact. A missing or different
proof yields `TSQ406`. This qualifies one supplied query; project hosts own enumeration of every
checked query and structural variant.

For PostgreSQL, `createPostgresContractReconciler` from `@typed-sql/postgres/reconciliation`
provides pure comparison rules for the supported primitive representations, built-in aliases
and nullability bounds. Unsupported structural, opaque or modifier comparisons remain explicit.
Known static invalidity diagnostics stay blocking when the engine accepts the statement.

### Schedule refresh in an explicit live host

`createLiveAnalysisScheduler` coordinates asynchronous refresh for an explicitly enabled compiler
or editor host. Construct its producer with `createNativeLiveAnalysisRunner({ adapter, contribution })`.
Importing either API does not connect to a database. Ordinary synchronous analysis does not start
refresh work.

Subscribe with a document identity/version, query identity, three project generations, and a
`LiveAnalysisRequest`. The request contains an opaque hashed connection-context identity, adapter
revision, static candidate, independent static claim and qualification policy. Do not use connection
strings as identities. The connection identity distinguishes authentication/session contexts; it does
not replace the expected database-context hash in the static claim.

The scheduler debounces requests, shares identical work across subscribers, limits active work per
connection context and across the project, and bounds queued work and retained records. Canceling one
subscriber leaves shared work running for others. Closing the last subscriber aborts the operation.
An adapter that ignores cancellation retains its concurrency slot until it actually settles; late
results cannot publish after cancellation or a deadline. `close()` aborts work and waits for sessions
to drain, so adapters must honor cancellation and enforce their own transport deadlines.

Every subscription captures `inputGeneration`, `contextGeneration` and `policyGeneration`. Call
`advance` when project inputs, database context, or analysis/decoding policy changes. Generations
must increase monotonically. Advancing invalidates all previous subscriptions and immediately
removes their contracts from `view`. A newer document version similarly fences older subscriptions
for that document. `closeDocument` releases its subscriptions and version history.

Subscribers receive `pending`, `usable-recorded-context`, `partial`, `rejected`, `conflict`,
`stale-context` or `unavailable` states. A superseded subscription's handle reports `stale-input`.
The producer's qualified output is checked against the request's SQL, context, static claim, policy,
adapter and parameter layout before publication. The immutable `view` supplies a coherent set of
active contracts for a later synchronous compiler pass; conflicting contracts fail closed.
A host must supply the expected context and configured qualification policy when consuming them.

Transport failures use bounded exponential backoff with jitter. Matching previously usable evidence
can remain in the view during a refresh or transient transport outage; its state does not claim a
fresh database check. Rejection, conflict, partial evidence or a known stale context removes it.
Authentication and other failures classified as requiring a change do not retry automatically.
Use `classifyError` on the runner to distinguish transport outages from such failures, and `retry`
for an explicit retry. Subscription callbacks are coalesced; replacing the same subscription after
receiving a state does not trigger another delivery of that unchanged state.

This scheduler holds an in-memory view only. It does not write the disposable cache, export durable
contracts, or activate CLI/editor watching. The host owns context freshness checks, project query
and variant enumeration, connection credentials, persistence and explicit publication of reviewed
compiler inputs.

### Persist disposable evidence between host sessions

`openAnalysisCache({ directory, workspaceContext })` opens a private disposable cache root, usually
`.typed-sql/cache/analysis/v1`. `workspaceContext` is a configured workspace/config digest. Different
namespaces share immutable objects without sharing their lookup entries. The cache validates its
ownership/version marker and refuses to claim an unrelated directory.

Call `lookup(request)` before asynchronous acquisition. It returns a publication token and, when
present, a validated cached outcome. A cached contract must match the exact current request,
including its static claim, context, adapter, qualification policy and parameter layout. The result
reports `recordedAt` and `freshness: "unverified"`; a disk hit does not establish current database
freshness. An offline host can consume a matching qualified contract through `createContractDialect`.
A live host separately decides when to check context or acquire new evidence.

After acquisition, pass that token, the same request and the outcome to `publish`. Its result is:

- `published` when the new entry is committed;
- `superseded` when another producer replaced that request or the namespace was invalidated;
- `capacity` when admitting the entry would exceed configured limits.

Unrelated request publications merge under a short filesystem lock. Two producers holding the
same token cannot both replace that entry. `invalidate()` rotates this namespace's epoch and clears
its entries, fencing pre-existing producers. Publishing `stale-context` also retires the namespace's
other entries because dependency coverage is conservative. Hosts coordinate this with scheduler
generation changes. Invalidation does not delete immutable objects or touch other namespaces.

The cache stores sanitized negative outcomes by exact request identity. Transient transport
failures are not persisted over previous evidence. A known rejection, conflict or partial result
replaces the previous outcome; resource pressure cannot retain a disproved contract. If even a
replacement index exceeds its object limit, the namespace is invalidated before reporting capacity.

Storage uses immutable `contexts/` and `queries/objects/` JSON plus atomic `indexes/` pointers.
A reservation ledger accounts for admitted payloads before writes; interrupted publishers can
overcount space until pruning reconstructs usage. Publication does not scan every cached object.
The index contains request digests, revisions, timestamps and sanitized negative status codes.
SQL text, source paths, executable type declarations, credentials and native error messages are
not persisted. Readers check bounded regular files, digests, context identity and qualification;
missing, corrupt or incompatible referenced objects throw instead of supplying types.

The cooperative lock protocol has fixed heartbeat/stale recovery settings, validates the held
lease before publication and keeps database work outside the lock. Objects are staged before an
index commits. Use the same cache protocol for every writer rather than modifying its files or
locks directly.

`prune()` preserves all objects referenced by every namespace index. It removes unreachable objects
and abandoned staging files after thirty days by default, or sooner under the payload budget.
`prune({ retentionMs: 0 })` removes all unreachable owned objects. Unrelated files and durable
contract directories are preserved. Defaults allow 4,096 entries per namespace, 128 namespaces,
8 MiB per object and a 256 MiB payload admission budget. Limits are configurable. A reduced budget
can leave referenced objects above the target; pruning reports retained bytes instead of deleting
active inputs.

Opening this cache does not enable CLI/editor refresh, create project catalogs or declarations,
record context-check observations, or export durable compiler inputs. Those operations belong to
the explicit host workflow. Frozen consumers use their durable contract closure independently of
this cache and its clock, contents or existence.

### Collect candidates before SQL inference

Compiler hosts use `collectSourceQueryCandidates` and `collectSqlFileQueryCandidates` from
`@typed-sql/compiler` to prepare native requests independently of semantic success. Both accept a
`DialectProfile` from `@typed-sql/core`, a validated snapshot and the selected decoding policy.
The profile supplies rendering and lexical parameter mechanics; collection never calls `analyze`.
`assertDialectProfile` validates its versioned mechanics independently of an analyzer.
For PostgreSQL, `postgresProfile()` supplies this lightweight input without loading its analyzer.

A candidate contains exact transient SQL, SQL-to-source offsets, ordered physical placeholder
occurrences, logical argument bindings and hashed conditional choices. Each conditional rendering
has its own candidate. SQL assets use the same named/repeated-parameter normalization as generated
factories: several physical binds can refer to one logical argument. A native description of those
physical arguments does not by itself prove their logical constraints are mutually compatible.

Collection shares source expansion with ordinary compilation. Native acquisition correlates repeated
conditions only when expressed as an identifier; repeated calls or property access need a captured condition
value rather than an assumed stable result. It reports incomplete rendering,
ambiguous placeholder layouts, dynamic SQL, runtime-sized fragment lists and resource limits.
It does not describe a representative list size as proof for arbitrary sizes. Explicit structural
values left unrendered, including unsupported `sql.ident` or `sql.raw` expressions, produce a
diagnostic rather than becoming ordinary native bind parameters.

`complete` means this source unit produced no collection errors. It does not prove valid SQL,
TypeScript correctness, safe statement preparation, native support, or qualification of an entire
project. Hosts enumerate the project source graph, collect each SQL asset, preserve diagnostics,
qualify all required variants and run the ordinary compiler/TypeScript checks. SQL text remains
transient; cache and durable contracts retain its digest. Application code continues importing
its grammar's `sql` tag.
