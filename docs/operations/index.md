---
title: Operate typed-sql
description: Choose schema, CI, verification, observability, and deployment controls independently as production needs grow.
pageType: landing
---

# Operate typed-sql

The query compiler needs a schema snapshot and an authoritative check. The remaining operational
features are optional controls that solve different deployment problems; adopting typed-sql does not
require enabling all of them.

## Choose a control

| Concern | Control | Evidence or output | When it runs |
| --- | --- | --- | --- |
| Stale schema input | [Schema snapshots](../guides/schema-snapshots.md) | Canonical snapshot and identity | Generation and CI |
| Query type correctness | [Compiler check](../getting-started/compiler-and-editor.md#use-the-stable-check) | Diagnostics and inferred contracts | Local development and CI |
| Query inventory and correlation | [Query manifests](../guides/query-manifests.md) | Deterministic, redacted manifest | Build or CI |
| Compiler/database agreement | [Live verification](../guides/live-verification.md) | Cached verification artifact | Controlled CI environment |
| Optimizer regressions | [Query-plan governance](../guides/query-plan-governance.md) | Redacted structured plans and review report | Controlled CI environment |
| Rolling migration safety | [Migration compatibility](../guides/migration-compatibility.md) | Forward and rollback compatibility findings | Migration review or CI |
| Runtime visibility | [Observability](../guides/observability.md) | Lifecycle events or OpenTelemetry spans | Application runtime |
| Support investigation | [Support bundles](../guides/support-bundles.md) | Previewed, redacted diagnostic archive | Explicit operator action |

## Minimum CI boundary

Generate or validate the snapshot, then run the stable compiler path:

```sh
pnpm exec typed-sql check --project tsconfig.json
```

Snapshot generation can require a database connection. Checking uses the generated evidence and does
not connect to the database unless live verification or plan inspection is explicitly configured.

## Add evidence progressively

Start with the failure you need to prevent:

1. Use snapshot drift checks when schema evidence can become stale.
2. Emit manifests when deployments need a deterministic query inventory.
3. Add live verification when compiler evidence must be compared with a controlled real database.
4. Add plan governance only for queries and environments where optimizer changes are actionable.
5. Run migration compatibility analysis when old and new application/schema versions overlap during
   deployment.

Each guide states its connection requirements, redaction rules, cache identity, and failure behavior.
Do not copy production credentials into generated artifacts or support bundles.
