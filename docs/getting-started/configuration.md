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
