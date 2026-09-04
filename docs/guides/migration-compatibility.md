---
title: Migration compatibility
pageType: how-to
description: Compare schema and query artifacts to find source, runtime, and rolling-deployment breaks before a migration ships.
---

# Migration compatibility

`typed-sql compat` compares two schema snapshots and their compiled query manifests. It answers two questions that a schema diff alone cannot:

- Can the older application run against the newer database?
- Can the newer application run against the older database?

The analyzer is offline and grammar-neutral. It does not apply migrations, contact a database, or require a particular migration framework. Existing tools continue to own migration ordering, locks, rollback, and production execution.

Applications adopting compatibility artifacts from typed-sql v1 should first follow the
[v1 upgrade guide](./upgrading-from-v1.md#adopt-compiler-and-ci-artifacts) so snapshots and manifests
come from one coherent package set.

## Produce the four inputs

Keep one snapshot and manifest from each application revision:

| Artifact | Meaning |
| --- | --- |
| `before.schema.json` | Catalog before the proposed migration |
| `before.queries.json` | Queries compiled from the older application against that catalog |
| `after.schema.json` | Catalog after the proposed migration |
| `after.queries.json` | Queries compiled from the newer application against that catalog |

Run snapshot generation and manifest generation at each revision:

```sh
pnpm exec typed-sql generate
pnpm exec typed-sql manifest

cp generated/db/schema.json artifacts/after.schema.json
cp .typed-sql/queries.json artifacts/after.queries.json
```

The exact generated directory comes from `outDir`; the manifest path comes from `manifest.outFile`. Preserve the corresponding `before` artifacts from the merge base, a build artifact, or a checked-in baseline.

## Analyze both deployment directions

```sh
pnpm exec typed-sql compat \
  --before artifacts/before.schema.json \
  --after artifacts/after.schema.json \
  --before-manifest artifacts/before.queries.json \
  --after-manifest artifacts/after.queries.json
```

Paths are resolved relative to `typed-sql.config.ts`. The command writes canonical JSON to `.typed-sql/compatibility.json` and prints every assessment, including informational findings. Each affected query includes its relative file, source range, variant fingerprint, and dependency range when the grammar supplied one.

Every database change is assessed in both directions:

| Direction | What it models |
| --- | --- |
| `before-app-after-database` | Old application instances remain while the migrated database is live |
| `after-app-before-database` | New application instances start before every database instance has migrated |

The report classifies findings as `compatible`, `deployment-order-sensitive`, `source-breaking`, `runtime-breaking`, or `unknown`. `unknown` is deliberate: unresolved queries, ambiguous dependencies, server-version changes, and unsupported semantics remain visible instead of being treated as safe.

## Configure CI policy

```ts
export default defineConfig({
  // dialect, schema, and outDir omitted
  compatibility: {
    reportFile: ".typed-sql/compatibility.json",
    failOn: "error",
  },
});
```

`--fail-on` overrides the config for one run:

```sh
pnpm exec typed-sql compat ... --fail-on warning
```

| Policy | Exit with code `1` when the report contains |
| --- | --- |
| `none` | Never; useful while adopting the check |
| `warning` | A warning or error |
| `error` | An error |

The JSON report is always written and lower-severity findings are always printed. A failing policy therefore changes the exit code without hiding evidence.

## Use plain SQL migrations

Apply plain SQL to a disposable database with the same runner used by the application, then regenerate the after-snapshot:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20260828_accounts.sql
pnpm exec typed-sql generate
pnpm exec typed-sql manifest
pnpm exec typed-sql compat \
  --before artifacts/before.schema.json \
  --after generated/db/schema.json \
  --before-manifest artifacts/before.queries.json \
  --after-manifest .typed-sql/queries.json
```

For MySQL, replace the migration command and grammar adapter; the compatibility command and report contract stay the same.

## Use an external migration workflow

For example, a project that already uses Prisma Migrate can keep Prisma as the migration runner:

```sh
pnpm exec prisma migrate deploy
pnpm exec typed-sql generate
pnpm exec typed-sql manifest
pnpm exec typed-sql compat \
  --before artifacts/before.schema.json \
  --after generated/db/schema.json \
  --before-manifest artifacts/before.queries.json \
  --after-manifest .typed-sql/queries.json
```

The same boundary works with Flyway, Liquibase, Drizzle Kit, Atlas, or an internal migration service: run the existing migration against a disposable database, let the configured `SchemaProvider` introspect it, then pass the resulting artifacts to `compat`. typed-sql consumes the outcome rather than the migration language.

## Interpret schema changes

The report carries before/after evidence for table, column, enum, domain, function, database-type, TypeScript-type, nullability, array, default, grammar-version, and server-version changes. Default expressions are represented by fingerprints, so secrets or operational expressions are not copied into reports.

Changes to inferred rows or ordered parameters produce a `query-contract` change. This captures type-policy and codec-facing changes even when the SQL text itself is unchanged.

Renames are intentionally conservative. Without explicit evidence, removing `display_name` and adding `full_name` is reported as a removal plus an addition. The analyzer does not guess that data, semantics, or every deployed query moved safely.

Adding a required column without a default and changing defaults can affect writes that do not name the changed column. Function overload additions and removals can change resolution. These are reported as deployment-order-sensitive even when a direct read dependency would miss the hazard.

## Artifact guarantees

Compatibility reports are deterministic, versioned, and validated at their public parser boundary. They contain hashes and relative source locations, but no SQL text, parameter values, connection configuration, default expressions, credentials, absolute paths, or driver errors.

The compiler API exposes `analyzeSchemaCompatibility()`, `serializeSchemaCompatibilityReport()`, and `parseSchemaCompatibilityReport()` for CI systems that need an in-memory workflow. Snapshot producers only need to emit the public `SchemaSnapshot` contract; migration-framework integration does not belong in the analyzer.
