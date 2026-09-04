---
title: Configuration
pageType: reference
description: Connect a typed-sql dialect, schema provider, generated snapshot, and TypeScript project.
---

# Configuration

Create `typed-sql.config.ts` in the application root. The config selects the dialect, schema provider, generated output, TypeScript projects, and type policy used by both inference and runtime decoding.

## PostgreSQL

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { createPgLiveVerifier, createPgPlanInspector, pg } from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: pg({
      connectionString,
      schemas: ["public"],
      typePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: {
    maxStructuralVariants: 64,
  },
  manifest: {
    outFile: ".typed-sql/queries.json",
  },
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

## MySQL

```ts
import { defineConfig } from "@typed-sql/core";
import { mysql, typePolicy } from "@typed-sql/mysql";
import { createMySql2LiveVerifier, createMySql2PlanInspector, mysql2 } from "@typed-sql/mysql/mysql2";

const connectionUri = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: mysql({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: mysql2({
      connectionUri,
      schemas: ["app"],
      typePolicy,
    }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: {
    maxStructuralVariants: 64,
  },
  manifest: {
    outFile: ".typed-sql/queries.json",
  },
  verification: {
    live: createMySql2LiveVerifier({ connectionUri, typePolicy }),
    proofFile: ".typed-sql/verification.json",
    concurrency: 4,
  },
  plans: {
    live: createMySql2PlanInspector({ connectionUri }),
    sampleValues(request) {
      if (request.parameters.length === 0) return undefined;
      return { identity: "representative-v1", values: request.parameters.map(() => 1) };
    },
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

## SQLite

```ts
import { defineConfig } from "@typed-sql/core";
import { sqlite, typePolicy } from "@typed-sql/sqlite";
import { nodeSqlite } from "@typed-sql/sqlite/node-sqlite";

const path = process.env.DATABASE_PATH ?? "app.db";

export default defineConfig({
  dialect: sqlite({ typePolicy }),
  schema: {
    file: "src/generated/db/schema.json",
    provider: nodeSqlite({ path, typePolicy }),
  },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  typePolicy,
  compiler: {
    maxStructuralVariants: 64,
  },
  manifest: {
    outFile: ".typed-sql/queries.json",
  },
  compatibility: {
    reportFile: ".typed-sql/compatibility.json",
    failOn: "error",
  },
});
```

The SQLite package does not expose native live-verification or query-plan inspector adapters,
so omit those optional config blocks.

## Generate and check

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
pnpm exec typed-sql drift
pnpm exec typed-sql manifest
pnpm exec typed-sql verify --live
pnpm exec typed-sql verify
pnpm exec typed-sql explain --compare artifacts/plans.json
pnpm exec typed-sql compat --before before.schema.json --after after.schema.json --before-manifest before.queries.json --after-manifest after.queries.json
```

`generate` introspects the configured database and writes deterministic schema metadata. `check` analyzes SQL and asks TypeScript to validate the inferred overlay. `drift` compares the committed snapshot and type-policy hash with the live database. `manifest` emits deterministic, source-relative compiler evidence for every configured project; see [Query manifests](../guides/query-manifests.md). `verify --live` compares that evidence with native prepare metadata, while `verify` validates the cached proof offline; see [Live verification](../guides/live-verification.md). `explain` captures redacted structured optimizer evidence and reviews explicit budgets; see [Query plan governance](../guides/query-plan-governance.md). `compat` compares before/after snapshots and manifests without contacting the database; see [Migration compatibility](../guides/migration-compatibility.md).

Connection strings stay in the config callback or environment. They are not written to generated files. Commit the generated snapshot so schema and type-policy changes are reviewable.

The same `typePolicy` must be passed to the dialect, schema provider, and runtime adapter. This keeps the inferred TypeScript type aligned with the value returned by the driver.
