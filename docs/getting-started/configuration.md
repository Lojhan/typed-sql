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
import { postgres, typePolicy } from "@typed-sql/postgres";
import { pg } from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: postgres({ typePolicy }),
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

## Checking durable query contracts

`typed-sql check --frozen` checks a project using a declared durable query-contract closure.
It requires an `analysis` configuration and a lightweight dialect profile. Missing contracts,
changed schema or decoding policies, and incompatible qualification evidence fail checking.
The command reads neither the disposable cache nor a database connection.

For PostgreSQL, register the profile separately from its optional analyzer:

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
  dialect: {
    ...postgresProfile(),
    loadAnalyzer: async () => (await import("@typed-sql/postgres")).postgres(),
  },
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

Publish the durable closure with `exportQueryContracts()` from `@typed-sql/analysis` after acquiring
and qualifying its contracts. Commit the manifest and every referenced object alongside the context
and schema. The CLI consumes this explicit closure; ordinary schema generation does not create it.
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

## Explicit live query checking

`typed-sql check --live` runs a finite native acquisition pass, then checks TypeScript against its
synchronous contract view. It requires `analysis.cache` target identities and an
`analysis.live.adapter` factory. Register executable factories with `defineAnalysisRegistration()`;
`defineAnalysisConfiguration()` accepts data only.

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
import recordedContext from "./generated/db/analysis-context.json" with { type: "json" };

const connectionContext = queryContractDigest({
  target: "development-primary",
  authorization: "application-role",
});

export const analysis = defineAnalysisRegistration<PostgresProfileSnapshot, PostgresTypePolicy>({
  mode: "live",
  context: recordedContext,
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
checks run before and after the batch; incompatible context observations retire recorded cache
evidence and require refreshed context/schema inputs. A conflict, unavailable facet or acquisition
failure prevents a successful live check, even when older recorded contracts exist.

The host closes its owned acquisition resources before TypeScript checking. Successful qualified
contracts enter the disposable cache; live checking does not modify durable exports. A later
`--offline` invocation can reuse matching recorded evidence. `--offline` and `--frozen` leave the live
factory unloaded, including when `analysis.mode` is `"live"`.

The live registration is consumed by the CLI check host. Other build and editor hosts must implement
analysis-mode handling explicitly; they do not inherit database access from this setting.

## Production profile

The following complete PostgreSQL profile starts from the same minimum and enables each artifact
family explicitly:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import {
  createPgLiveVerifier,
  createPgPlanInspector,
  pg,
} from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: postgres({ typePolicy }),
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
