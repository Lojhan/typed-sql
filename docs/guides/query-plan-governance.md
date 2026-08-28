---
title: Query plan governance
description: Capture redacted optimizer evidence and review explicit query-plan budgets without executing application statements.
---

# Query plan governance

`typed-sql explain` connects stable query fingerprints from the manifest to structured optimizer evidence from a representative database. It can make an accidental sequential scan, unexpected cardinality estimate, or cost increase visible in review. It does not predict latency or make the optimizer deterministic.

Plan capture is optional. Compilation, editor inference, manifest generation, and ordinary execution do not connect to a database or read plan artifacts.

## Configure an inspector

PostgreSQL exposes its adapter from the driver-specific subpath:

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres } from "@typed-sql/postgres";
import { createPgPlanInspector } from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: postgres(),
  schema: { file: "src/generated/db/schema.json" },
  outDir: "src/generated/db",
  projects: ["tsconfig.json"],
  manifest: { outFile: ".typed-sql/queries.json" },
  plans: {
    live: createPgPlanInspector({ connectionString }),
    artifactFile: ".typed-sql/plans.json",
    reportFile: ".typed-sql/plan-review.json",
    concurrency: 4,
    failOn: "violation",
    budgets: {
      defaults: {
        maximumTotalCostIncreaseRatio: 1.5,
        forbiddenNodeKinds: ["Seq Scan"],
      },
    },
  },
});
```

For MySQL, use `createMySql2PlanInspector()` from `@typed-sql/mysql/mysql2`. The application owns the `pg` or `mysql2` installation; grammar packages do not install a database driver.

## Capture and compare

Generate the query inventory, then capture a baseline in a representative disposable database:

```sh
pnpm exec typed-sql manifest
pnpm exec typed-sql explain --out artifacts/plans.json
```

On a later revision, capture current evidence and compare it with that baseline:

```sh
pnpm exec typed-sql explain \
  --compare artifacts/plans.json \
  --out .typed-sql/plans.json \
  --report .typed-sql/plan-review.json
```

If `--compare` and `--out` name the same file, the command reads the baseline before replacing it with the current artifact. Keep a durable baseline in version control or CI artifacts when review history matters.

## Parameter samples

PostgreSQL 18 can request a generic JSON plan without parameter values. MySQL needs application-supplied transient values for parameterized statements. Configure a sample provider when a dialect requires them or when a custom PostgreSQL plan should reflect representative selectivity:

```ts
plans: {
  live: createMySql2PlanInspector({ connectionUri }),
  sampleValues(request) {
    if (request.parameters.length === 0) return undefined;
    return {
      identity: "representative-production-shape-v1",
      values: request.parameters.map((parameter) =>
        parameter.tsType === "bigint" ? 10_000n : "active",
      ),
    };
  },
}
```

Values exist only in memory while the driver asks the database to plan the statement. SQL text, values, connection configuration, driver errors, absolute paths, and the sample identity are excluded from the artifact. Only a hash of the sample identity is retained so two captures can determine whether their evidence is comparable. Treat the identity as a stable non-secret label anyway.

Missing samples, an incorrect sample count, unresolved queries, unsupported operations, adapter failures, and sample-provider failures remain explicit as skipped or unavailable evidence. They are never silently treated as passing plans.

## Safety boundary

The bundled adapters use structured `EXPLAIN` and never request `ANALYZE`. PostgreSQL uses `EXPLAIN (GENERIC_PLAN TRUE, FORMAT JSON)` when no sample is supplied and parameterized `EXPLAIN (FORMAT JSON)` when one is. MySQL uses `EXPLAIN FORMAT=JSON`. These forms plan statements without executing their effects, including write statements.

Do not replace the inspector with an adapter that uses `EXPLAIN ANALYZE` unless execution is explicitly isolated and intended: `ANALYZE` executes the statement. Use a least-privilege account and a disposable, representative environment because planning still reads catalogs, optimizer settings, and statistics.

## Budgets and outcomes

Repository-wide defaults and per-fingerprint overrides support:

- maximum total estimated cost;
- maximum estimated rows;
- maximum cost or row-estimate increase ratios;
- required node kinds;
- forbidden node kinds.

Per-query overrides use the variant fingerprint from the query manifest:

```ts
budgets: {
  defaults: { maximumTotalCostIncreaseRatio: 1.5 },
  queries: {
    "sha256:…": {
      maximumEstimatedRows: 1_000,
      requiredNodeKinds: ["Index Scan"],
    },
  },
}
```

Review entries have five distinct outcomes: `pass`, `violation`, `incomparable`, `unavailable`, and `unbudgeted`. Version, schema, optimizer-setting, statistics, or sample changes make relative comparisons incomparable. Absolute budgets can still fail in a changed environment because they evaluate the current evidence alone.

`plans.failOn` and `--fail-on` accept `none`, `violation`, or `uncertainty`. The last option fails on violations, incomparable evidence, or unavailable evidence. The JSON review remains the authoritative machine-readable result.

## Interpret evidence conservatively

Costs are optimizer-specific estimates, not milliseconds, and cannot be compared across PostgreSQL and MySQL. Statistics refreshes, server upgrades, settings, extensions, data shape, and optimizer choices can change a plan without a source change. The artifact records the server version, relevant settings, schema hash, and a statistics fingerprint so the report can say “incomparable” instead of inventing certainty.

Node inventories intentionally exclude filter expressions and literal-bearing fields. They are useful review evidence, not authoritative index advice. Confirm important findings with database-native investigation and workload measurements.

See the PostgreSQL [`EXPLAIN`](https://www.postgresql.org/docs/current/sql-explain.html) and MySQL [`EXPLAIN`](https://dev.mysql.com/doc/refman/8.4/en/explain.html) references for database-specific behavior.
