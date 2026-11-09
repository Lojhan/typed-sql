---
title: Configuration
pageType: reference
description: Configure the minimal schema and compiler path, then add optional production evidence controls independently.
---

# Configuration

Create `typed-sql.config.ts` in the application root. A minimal config selects one dialect, a schema
provider, a deterministic output location, TypeScript projects, and one shared type policy. Production
controls extend this profile; they are not required for a first query.

## Minimal local profile

This complete PostgreSQL profile is the smallest configuration for live introspection and checking:

```ts
import { defineConfig } from "@typed-sql/core";
import { typePolicy } from "@typed-sql/postgres";
import { postgresProfile } from "@typed-sql/postgres/profile";
import { pg } from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: {
    ...postgresProfile({ typePolicy }),
    loadAnalyzer: async () => (await import("@typed-sql/postgres/analysis")).postgres({ typePolicy }),
  },
  schema: {
    file: "generated/db/schema.json",
    provider: pg({ connectionString, schemas: ["public"], typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
});
```

Use the corresponding complete profile in the [PostgreSQL](./postgresql.md#4-create-a-minimal-config),
[MySQL](./mysql.md#4-create-a-minimal-config), or [SQLite](./sqlite.md#4-create-a-minimal-config)
quickstart. Keep connection values in environment-backed callbacks; generated artifacts do not store
them.

Generate and check with:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --project tsconfig.json
```

## Minimal fields

| Field | Responsibility |
| --- | --- |
| `dialect` | Selects grammar semantics, capability policy, placeholders, and diagnostics |
| `schema.file` | Identifies the canonical snapshot used when no live connection is present |
| `schema.provider` | Introspects the selected database when generation or drift needs live evidence |
| `outDir` | Receives deterministic generated compiler metadata |
| `projects` | Selects TypeScript projects analyzed by compiler commands |
| `typePolicy` | Keeps database-to-TypeScript inference and adapter decoding aligned |
| `compiler` | Optionally changes bounded source, query, declaration, or structural-variant limits |

The generated files are compiler inputs, not application imports. Commit the snapshot when review and
CI need a stable schema identity.

## Lightweight roots and analyzer imports

Application code imports `sql` from its selected grammar root. Roots also expose runtime plan
primitives, rendering and type policy. Profile construction belongs to the explicit `/profile`
entrypoint. Importing a root does not load its offline analyzer or introspection provider.

The previous full grammar exports live at explicit `/analysis` entrypoints:

| Grammar | Profile factory (`/profile`) | Eager analyzer import |
| --- | --- | --- |
| PostgreSQL | `postgresProfile()` | `postgres` from `@typed-sql/postgres/analysis` |
| MySQL | `mysqlProfile()` | `mysql` from `@typed-sql/mysql/analysis` |
| SQLite | `sqliteProfile()` | `sqlite` from `@typed-sql/sqlite/analysis` |
| SQL Server | `sqlserverProfile()` | `sqlserver` from `@typed-sql/sqlserver/analysis` |
| DuckDB | `duckdbProfile()` | `duckdb` from `@typed-sql/duckdb/analysis` |

Move existing analyzer factory, semantic routing, extension-manifest and catalog-provider imports
from the root to `/analysis`. That compatibility entrypoint retains the previous full export
surface. Driver integrations remain explicit subpaths such as `/pg` and `/mysql2`.

The local configuration above registers a separate `loadAnalyzer` contribution. Development hosts
load it when offline inference needs it; constructing the profile does not load it. Contract-only
configuration can omit that contribution and use the profile with a saved schema and durable query
contracts, as shown below.

## Checking durable query contracts

`typed-sql check --frozen` checks a project using a declared durable query-contract closure.
It requires an `analysis` configuration and a lightweight dialect profile. Missing contracts,
changed schema or decoding policies, and incompatible qualification evidence fail checking.
The command reads neither the disposable cache nor a database connection.

For PostgreSQL, register the profile separately from its optional analyzer. This example pins a
recorded context; automatic target selection is shown below:

```ts
import { defineConfig } from "@typed-sql/core";
import { defineAnalysisConfiguration } from "@typed-sql/analysis";
import { postgresProfile } from "@typed-sql/postgres/profile";
import {
  postgresContractIdentity,
  postgresContractReconciliationOwner,
} from "@typed-sql/postgres/contract-profile";
import recordedContext from "./generated/db/analysis-context.json" with { type: "json" };

export default defineConfig({
  dialect: postgresProfile(),
  schema: { file: "generated/db/schema.json" },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  analysis: defineAnalysisConfiguration({
    mode: "frozen",
    context: recordedContext,
    identity: postgresContractIdentity(),
    contractsDir: "generated/db/contracts",
    qualification: {
      mode: "native-required",
      owner: postgresContractReconciliationOwner,
      requiredNativeFacets: [],
    },
  }),
});
```

The context file records the acquisition context; it does not establish current database freshness.
The installed interpreter supplies compatibility identities independently of the artifacts.
Use the same qualification policy when producing and consuming contracts. A native-required policy
requires a qualified comparison proof even when its additional native-facet list is empty.

Publish the durable closure with `typed-sql generate --queries` or `exportQueryContracts()` from
`@typed-sql/analysis` after acquiring and qualifying its contracts. Commit the manifest and every
referenced object alongside the schema and any explicit context pin. Ordinary schema generation does not create it.
Changing SQL requires matching contracts for the new statements.

```sh
pnpm exec typed-sql check --frozen --project tsconfig.json
```

Setting `analysis.mode` to `"frozen"` also selects this path without the flag. The optional
`loadAnalyzer` callback remains unloaded during frozen checking. SQL-file imports receive
in-memory factory declarations, so checking does not write adjacent declaration files.

## Offline checks and recorded cache reuse

`typed-sql check --offline` overrides a configured live or frozen preference and never initiates
native acquisition. With an `analysis` configuration, omitted `mode` defaults to `"offline"`.
Matching durable contracts supply the query types before the analyzer loads. In hybrid qualification
mode, an uncovered query loads the registered analyzer and uses its ordinary conservative analysis.
A native-required miss reports missing evidence instead of substituting an unqualified static type.

An optional `analysis.cache` enables reuse of disposable qualified query evidence:

| Field | Responsibility |
| --- | --- |
| `connectionContext` | A SHA-256 identity for the explicitly selected database target and authorization scope |
| `adapter.id`, `adapter.version` | The installed native adapter's compatibility identity |
| `directory` | Optional cache root, relative to the config; defaults to `.typed-sql/cache/analysis/v1` |

Keep target identities distinct across endpoints and authorization scopes. Supply adapter revisions
from the installed adapter owner; PostgreSQL exports `postgresContractAdapterVersion` through
`@typed-sql/postgres/contract-profile`. These keys supplement the recorded context, schema, decoding,
interpreter and qualification identities; they do not replace them.

Cache lookup needs the rendered SQL and configured identities, without an analyzer claim or a
database roundtrip. A hit establishes compatibility with the recorded context and leaves current
remote freshness unverified. Known rejection, conflict or stale-context evidence blocks reuse;
a transport outage does not overwrite a valid recorded result. Frozen checks ignore this cache.

When `context` is omitted, the cache records a selection for the configured target, schema, profile
and decoding policy. Offline checking prefers that recorded selection, then a compatible durable
selection; known stale observations block fallback. If neither exists, hybrid mode can analyze
ordinary offline rules without claiming a native observation. Native-required mode needs recorded
qualified inputs. Frozen checking reads only the durable manifest's target/context selection and
ignores disposable cache state. An explicit `context` keeps its pinned behavior.

## Explicit live query checking

`typed-sql check --live` runs a finite native acquisition pass, then checks TypeScript against its
synchronous contract view. It requires `analysis.cache` target identities and an
`analysis.live.adapter` factory. Register executable factories with `defineAnalysisRegistration()`;
`defineAnalysisConfiguration()` accepts data only.

Omit `context` to discover and refresh the database epoch automatically. The installed interpreter,
schema, decoding policy and configured target identity still constrain every accepted observation.
The following value can be assigned to the `analysis` field of the profile configuration above.
The dialect registration also needs its lazy `loadAnalyzer`, because live qualification compares
independent static claims even for queries that the analyzer already resolves.

```ts
import { defineAnalysisRegistration, queryContractDigest } from "@typed-sql/analysis";
import {
  postgresContractAdapterVersion,
  postgresContractIdentity,
  postgresContractReconciliationOwner,
} from "@typed-sql/postgres/contract-profile";
import type { PostgresProfileSnapshot, PostgresTypePolicy } from "@typed-sql/postgres/profile";

const connectionContext = queryContractDigest({
  target: "development-primary",
  authorization: "application-role",
});

export const analysis = defineAnalysisRegistration<PostgresProfileSnapshot, PostgresTypePolicy>({
  mode: "live",
  identity: postgresContractIdentity(),
  qualification: {
    mode: "native-required",
    owner: postgresContractReconciliationOwner,
    requiredNativeFacets: ["runtime-type"],
  },
  cache: {
    connectionContext,
    adapter: { id: "@typed-sql/postgres/pg-contracts", version: postgresContractAdapterVersion },
  },
  live: {
    async adapter({ schema, typePolicy }) {
      const { Pool } = await import("pg");
      const { createPgNativeContractAdapter } = await import("@typed-sql/postgres/pg-contracts");
      const { createPostgresContractReconciler } = await import("@typed-sql/postgres/reconciliation");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      try {
        const adapter = createPgNativeContractAdapter({ pool, schema, typePolicy });
        return {
          connectionContext,
          adapter,
          contribution: createPostgresContractReconciler({ schema, typePolicy }),
          inspectContext: (signal) => adapter.inspectContext(signal),
          close: () => pool.end(),
        };
      } catch (error) {
        await pool.end();
        throw error;
      }
    },
  },
});
```

Install the optional driver only in projects using that native adapter. Use a dedicated acquisition
pool and a target identity that distinguishes the actual endpoint and authorization scope. The
factory obtains credentials at invocation time; they do not enter persisted query evidence.
PostgreSQL acquisition retains its [declared statement and server scope](../dialects/postgresql.md#native-query-contracts).

Every distinct candidate receives independent native qualification, including successful static
results. Work is bounded by concurrency, per-query deadlines and an overall batch deadline. Context
checks run before and after the batch. A new compatible epoch replaces the target's recorded
selection and retires older query evidence. A change during the batch rejects it. An incompatible
schema/profile observation requires refreshed schema or configuration inputs. A conflict, unavailable facet or acquisition
failure prevents a successful live check, even when older recorded contracts exist.

The host closes its owned acquisition resources before TypeScript checking. Successful qualified
contracts enter the disposable cache; live checking does not modify durable exports. A later
`--offline` invocation can reuse matching recorded evidence. `--offline` and `--frozen` leave the live
factory unloaded, including when `analysis.mode` is `"live"`.

After clearing the cache or retiring its evidence, check a query live again before reusing it
offline. Returning to the same database context does not restore retired query contracts.

The live registration is consumed by CLI query checking/generation and by explicitly live language
server projects. Offline and frozen editor modes leave this factory unloaded. Live editor context
observations are request-driven and coalesced; optional `live.contextIntervalMs` adjusts their
five-second default interval. Other build hosts must implement analysis-mode handling explicitly
and do not inherit database access from this setting. See [recorded contracts in editors](../guides/editors.md#recorded-query-contracts).

Finite live checking and query generation can restart up to twice after confirmed context drift
when context selection is automatic. Attempts share the configured batch deadline, and each closes
its services before the next begins. Explicit context pins still require a deliberate refresh.
Cleanup failures and cancellation are not retried, and consistency checks remain active on every
attempt.

## Watching query checks

Use `--watch` with `check` to recheck after source, schema, configuration or durable contract
changes. Choose the same analysis mode as for a one-shot check:

```sh
pnpm exec typed-sql check --watch --offline
pnpm exec typed-sql check --watch --frozen
pnpm exec typed-sql check --watch --live
```

Checks run serially and coalesce edits received during an active pass. Each pass reloads its
configuration and uses the ordinary checking and qualification rules. Errors keep the watcher
running so correcting an input triggers another check. Disposable cache writes do not trigger
checks, and watching does not export durable contracts or refresh the schema snapshot.

Live watching contacts the database during a triggered check. It does not poll an idle database;
database-only changes are observed during the next triggered check. Offline and frozen passes
leave native adapter factories unloaded. Stop watching with Ctrl+C.

## Generating durable query inputs

Query generation reads the configured schema and installed interpreter identity, prepares every
candidate in the selected TypeScript projects, and checks the exact prospective contract view with
TypeScript before publishing it. It does not invoke the schema provider; refresh the schema input
separately when the database schema changes. Without an explicit context pin, live generation
discovers the current compatible context and includes its target-bound selection in the manifest.

```sh
pnpm exec typed-sql generate --queries --live
pnpm exec typed-sql generate --queries --live --qualification native-required --check
pnpm exec typed-sql check --frozen
```

`--live` independently acquires and qualifies every candidate. `--offline` reuses matching durable
or cached contracts and, under hybrid qualification, materializes supported offline grammar rules.
`--qualification native-required` requires qualified native evidence for all candidates; it cannot
turn an ordinary offline result into native proof.

Offline materialization checks that reloading a contract preserves the analyzer's ordered logical
types and result kind. Unsupported refinements and partial native identities that cannot be
represented safely produce an error instead of an optimistic artifact. Already qualified native
contracts retain their native identity evidence when exported.

```sh
pnpm exec typed-sql generate --queries --offline
pnpm exec typed-sql generate --queries --offline --check
```

`--check` compares the prospective export with the current durable manifest and fails when they
differ. It writes no durable objects; a live pass can still refresh disposable evidence. `--out`
selects a contract directory relative to the config, and `--project` selects a complete project.
Single-file query generation is rejected because it would replace a project closure with a partial
set of queries. The exported manifest contains exactly the selected projects' contracts.

Generation prints a semantic diff of queries and reusable declarations. Add `--json` for the
complete before/after records, including ordered parameters, result fields, native evidence,
decoding policy, qualification and incomplete native facets:

```sh
pnpm exec typed-sql generate --queries --offline --check --json
```

The report identifies current callers by relative file and source position. A removed query has
no current caller; durable contracts do not retain historical application paths. SQL changes appear
as removal/addition rather than an assumed equivalence. `--check --json` still exits unsuccessfully
when the prospective export differs and preserves the durable manifest.

Publication serializes cooperating exporters and checks the original manifest identity. Source,
config, schema and project inputs are checked again immediately before the atomic manifest update.
A failed input fence leaves the old manifest available; immutable unreferenced objects may remain.
Old objects are retained so readers that captured the previous manifest can finish loading it.
Commit the manifest and referenced `contexts/` and `queries/` objects for frozen CI. Disposable cache
refresh alone does not update those reviewed inputs.

## Inspecting and pruning analysis cache

With `analysis.cache` configured, inspect its workspace/configuration namespace without connecting
or creating cache storage:

```sh
pnpm exec typed-sql cache status
pnpm exec typed-sql cache status --json
pnpm exec typed-sql cache prune --retention-days 30
```

Status reports indexed outcomes, observed contexts, unverified remote freshness and indexed query
contracts/catalog selections missing from the durable export. These are index observations, not
proof of current database validity or full project coverage. Active requests in other processes
are unobserved; editor status reports its own live session.

Pruning removes unreachable owned objects after the retention interval, or earlier when enforcing
the cache byte limit. `--retention-days 0` removes all unreachable objects. Indexed objects across
workspace namespaces, durable exports and unrelated `.typed-sql` artifacts are preserved. An absent
namespace remains absent. Invalid ownership or corrupted indexes produce an error.

## Production profile

The following complete PostgreSQL profile starts from the same minimum and enables each artifact
family explicitly:

```ts
import { defineConfig } from "@typed-sql/core";
import { typePolicy } from "@typed-sql/postgres";
import { postgresProfile } from "@typed-sql/postgres/profile";
import {
  createPgLiveVerifier,
  createPgPlanInspector,
  pg,
} from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: {
    ...postgresProfile({ typePolicy }),
    loadAnalyzer: async () => (await import("@typed-sql/postgres/analysis")).postgres({ typePolicy }),
  },
  schema: {
    file: "generated/db/schema.json",
    provider: pg({ connectionString, schemas: ["public"], typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: { maxStructuralVariants: 64 },
  manifest: { outFile: ".typed-sql/queries.json" },
  verification: {
    live: createPgLiveVerifier({ connectionString, typePolicy }),
    proofFile: ".typed-sql/verification.json",
    concurrency: 4,
  },
  plans: {
    live: createPgPlanInspector({ connectionString }),
    artifactFile: ".typed-sql/plans.json",
    reportFile: ".typed-sql/plan-review.json",
    concurrency: 4,
    failOn: "violation",
  },
  compatibility: {
    reportFile: ".typed-sql/compatibility.json",
    failOn: "error",
  },
});
```

Do not copy this profile as a maturity checklist. Select controls by failure mode:

| Optional block | Command and purpose | Guide |
| --- | --- | --- |
| `compiler` | Bound structural expansion and resource use | [Performance](../concepts/performance.md) |
| `manifest` | `typed-sql manifest` emits a redacted query inventory | [Query manifests](../guides/query-manifests.md) |
| `verification` | `typed-sql verify --live` compares native database evidence | [Live verification](../guides/live-verification.md) |
| `plans` | `typed-sql explain` captures and reviews structured plans | [Query plan governance](../guides/query-plan-governance.md) |
| `compatibility` | `typed-sql compat` checks mixed-version schema/query contracts | [Migration compatibility](../guides/migration-compatibility.md) |

SQLite does not expose native live-verification or plan-inspector adapters. MySQL uses its own
`mysql2` provider, verifier, and inspector. Dialect-specific availability belongs to the
[dialect pages](../dialects/index.md), while the [operations overview](../operations/index.md) helps
choose and sequence these controls.

## Type-policy consistency

Pass the same policy to the dialect, live schema provider, and runtime adapter. A driver parser or
codec that returns a different JavaScript shape can invalidate a static contract; configure the
matching policy instead of asserting a narrower type. See [Database type mappings](../reference/type-mappings.md).
