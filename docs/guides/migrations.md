---
title: Manage database migrations
description: Author SQL and TypeScript migrations, block unexpected schema drift, reconcile manual changes, and initialize a fresh PostgreSQL database.
pageType: how-to
---

# Manage database migrations

The migration CLI runs reviewed SQL through an explicit database adapter. It checks the live schema against independently replayed migration history before applying new work. The PostgreSQL adapter owns locks, transactions, script parsing, catalog evidence and history storage. The neutral runner owns migration files, checks, immutable plans and recovery.

Use [migration compatibility](./migration-compatibility.md) independently when another tool owns execution. `typed-sql compat` remains offline and does not require native migration history.

## Configure explicit targets

Install the migration package, grammar, CLI and application-owned driver:

```sh
pnpm add @typed-sql/postgres pg
pnpm add -D @typed-sql/cli @typed-sql/migrations
```

Configure a real target and a separately provisioned empty replay database. Neither `plan` nor `apply` creates, resets or drops a database. `disposable: true` permits replaying migration SQL; select a database reserved for that purpose.

```ts
import { defineConfig } from '@typed-sql/core';
import { defineMigrations } from '@typed-sql/migrations';
import { postgres, typePolicy } from '@typed-sql/postgres';
import { createPgMigrationTarget } from '@typed-sql/postgres/migrations';
import { pg } from '@typed-sql/postgres/pg';

const databaseUrl = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('Set DATABASE_URL');
  return value;
};
const replayUrl = () => {
  const value = process.env.MIGRATION_REPLAY_URL;
  if (!value) throw new Error('Set MIGRATION_REPLAY_URL');
  return value;
};

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: 'generated/db/schema.json',
    provider: pg({ connectionString: databaseUrl, schemas: ['public'], typePolicy }),
  },
  outDir: 'generated/db',
  projects: ['tsconfig.json'],
  typePolicy,
  migrations: defineMigrations({
    directory: 'migrations',
    replayTarget: 'replay',
    targets: {
      local: createPgMigrationTarget({
        connectionString: databaseUrl,
        expected: { database: 'app_dev' },
        classification: 'development',
      }),
      replay: createPgMigrationTarget({
        connectionString: replayUrl,
        expected: { database: 'app_migration_replay' },
        classification: 'test',
        disposable: true,
      }),
    },
    policy: { drift: 'block', unknownEvidence: 'block', managedNamespaces: ['public'] },
  }),
});
```

Target construction is lazy: importing config does not load `pg` or open the target. `expected.database` must match the observed database. Use `expected.server` when server identity is also required. The replay database must have a different observed database name from the application target; this conservative rule prevents socket/proxy/address aliases from replaying SQL on the live database. Keep the ledger namespace separate from managed application namespaces; the adapter defaults to `typed_sql` for history and `public` for managed catalog capture.

To retain structural descriptions for future history views, set `captureDetails: true` on the PostgreSQL migration target. The default retains fingerprints only. Detailed capture records column types, nullability and default presence; enum labels; relation kinds; index methods, uniqueness and key/included column names; and constraint column references. Expression indexes retain expression/predicate presence, without their SQL. It excludes routine bodies, default literals, view definitions and connection configuration. Names and enum labels are retained as schema metadata, so enable this only when that metadata belongs in your migration artifacts and ledger. These optional details support historical display; authoritative drift comparison continues to use the original object fingerprints. Older history remains fingerprint-only and cannot reconstruct missing definitions. Changing this option requires a new plan before apply because plans bind their captured evidence.

## Start with an empty database

Provision an empty database and role with your infrastructure tooling, then:

```sh
pnpm exec typed-sql migrate init
pnpm exec typed-sql migrate init --apply
pnpm exec typed-sql migrate new initial-schema --format ts
```

Edit the generated `.migration.ts` entry. Application imports come from the grammar, never generated schema files:

```ts
import { defineMigration } from '@typed-sql/migrations';
import { sql } from '@typed-sql/postgres';

export default defineMigration({
  id: '001_initial_schema',
  transaction: 'required',
  up: [sql`create table public.accounts (id integer primary key, display_name text not null)`],
  down: [sql`drop table public.accounts`],
});
```

Preserve the generated ID in a real migration. The short ID above only illustrates the interface. No after-schema snapshot is needed to author initial DDL. The migration loader renders operations without claiming that application inference understands every DDL statement.

```sh
pnpm exec typed-sql migrate plan --target local --out .typed-sql/migrations/initial.json
pnpm exec typed-sql migrate apply --target local --plan .typed-sql/migrations/initial.json
pnpm exec typed-sql generate
pnpm exec typed-sql check
```

A database without native history must also have an empty managed catalog. Existing objects trigger a drift block, not automatic adoption. Replay the same full history on a second empty database to verify reproducibility.

Transactional replay rolls its scratch changes back, leaving the replay database reusable. A history containing nontransactional operations consumes its explicitly disposable empty replay target; provision another empty target for the next replay. The CLI does not silently reset it.

## Use plain SQL files

`migrate new add-status --format sql` creates a directory containing `migration.json` and `up.sql`. Metadata names the optional down asset and phase-specific checks:

```json
{
  "formatVersion": 1,
  "id": "002_add_status",
  "transaction": "required",
  "up": "up.sql",
  "down": "down.sql"
}
```

Assets stay inside their migration directory. Files and user-owned helper imports are immutable after a successful application, including after reversal. Missing files, changed hashes, duplicate IDs and unapplied predecessors block execution. Make a new migration rather than editing deployed history.

Set `migrations.defaultFormat` to `sql` or `ts`. A checked-in `migrations.templateDirectory` can supply `migration.ts`, `up.sql`, `down.sql` and `migration.json`; absent template files use the built-in defaults. Text placeholders are `{{id}}`, `{{name}}` and `{{sqlModule}}` (a JSON-quoted grammar package name). Template metadata can set description, transaction mode, checks, irreversibility and reconciliation intent; the runner generates IDs and asset paths. SQL scaffolds become discoverable atomically after all files are written. A malformed template fails without publishing a partial migration directory.

SQL-in-TS is declarative: `up` and `down` are ordered operations, not callbacks receiving a live executor. The loader captures operations and source dependencies into a plan; apply does not reevaluate migration modules. Module loading is trusted local code, not a sandbox. Static imports are supported; migration TS cannot read `process.env` or use dynamic imports. Connection configuration belongs outside migration modules. Parameters support finite JSON scalar/array/object values only where the driver accepts them; unsupported runtime values fail before execution.

## Add global and migration-local checks

Use `checks.noRows`, `checks.assertBoolean`, `checks.objectExists`, `checks.objectAbsent`, `checks.schemaMatches`, or `checks.applicationSnapshotCurrent`. Every check has an ID and an optional actionable message. A data assertion is encoded separately from values and uses adapter-owned bounded assertion semantics.

```ts
import { checks, defineMigration } from '@typed-sql/migrations';
import { sql } from '@typed-sql/postgres';

export default defineMigration({
  id: '003_require_account_names',
  checks: {
    beforeUp: [checks.noRows({
      id: 'no-empty-account-names',
      query: sql`select 1 from public.accounts where display_name = ''`,
      message: 'Populate empty account names before applying this migration.',
    })],
  },
  up: [sql`alter table public.accounts add constraint account_name_present check (display_name <> '')`],
  irreversibleReason: 'Use an explicit corrective migration to change the constraint.',
});
```

Project `migrations.checks` and local checks add together. Conflicting IDs are errors; local configuration cannot silently remove global policy. Required checks block on failure, unknown evidence, permission failure or timeout. Optional advisory checks explicitly use `severity: 'warning'`.

Phases are `beforeBatch`, `beforeUp`, `afterUp`, `beforeDown`, `afterDown` and `afterBatch`. Starting-schema freshness runs before the batch, not against the original snapshot after every intentional change. Checks depending on earlier pending migrations remain deferred during planning and run at their execution phase. Transactional postcondition failures roll back SQL and applied history together. Nontransactional failures can leave effects and require inspection.

The migration lock serializes runners, not application traffic. A passing data observation can become false while another application writes. Use native constraints, isolation, or coordinated locks for correctness. Checks inside a writable DDL transaction are trusted SQL; classifying SELECT does not prove absence of side effects.

For an additional application-snapshot freshness gate, compute the canonical hash of the selected compiler input in configuration and add a project `beforeBatch` check:

```ts
import { readFile } from 'node:fs/promises';
import { calculateSchemaHash, parseSchemaSnapshot } from '@typed-sql/schema';
import { checks } from '@typed-sql/migrations';

const appSnapshot = parseSchemaSnapshot(JSON.parse(
  await readFile(new URL('./generated/db/schema.json', import.meta.url), 'utf8'),
));
const freshness = checks.applicationSnapshotCurrent({
  id: 'application-snapshot-current',
  schemaHash: calculateSchemaHash(appSnapshot),
  message: 'Refresh the compiler snapshot after known migrations before starting another batch.',
});
// Inside defineMigrations: checks: { beforeBatch: [freshness] }
```

This optional check captures the compiler schema on the same pinned connection using the adapter's type policy and blocks stale/missing/unsupported evidence. Enable it after greenfield generation; native migration execution otherwise needs no compiler artifacts. It supplements independent migration-head drift rather than replacing it, so refreshing an application snapshot still cannot bless manual DDL. Use it at batch start, not after each intentional schema change.

## Put static policy in JSON

Keep connections in `typed-sql.config.ts`. Global static policy can live in a JSONC file selected by `migrations.policyFile`, or by this root metadata in a configured TypeScript project:

```json
{
  "typedSql": {
    "migrations": { "policyFile": "./migration-policy.json" }
  }
}
```

```json
{
  "drift": "block",
  "unknownEvidence": "block",
  "managedNamespaces": ["public"],
  "reconciliation": "explicit-evidence"
}
```

The CLI reads `typedSql` metadata independently; it is not a `compilerOptions` field. Inherited paths resolve from their declaring tsconfig. Conflicting project policies, cycles, unknown policy fields and attempts to disable blocking are rejected. Select one inline policy or one policy file. Use `--project` for an explicit project selection. The repository verifies this metadata through TypeScript 7 configuration discovery. `beforeBatch` and `afterBatch` checks declared on selected migrations compose with project batch checks once at their batch boundary; no local phase is silently ignored. Apply and baseline reports retain advisory findings. New history entries include client UTC timestamps and elapsed execution time.

## Verify both application revisions

`migrate verify` executes only on an explicitly disposable empty replay target. First capture compiler snapshots at an explicit historical boundary and the proposed final migration:

```sh
pnpm exec typed-sql migrate verify --target replay --before-through 001_initial_schema --capture-dir .typed-sql/review
```

Use `--before-through empty` for the initial schema. Capture mode reports `compatibility: not-evaluated`; replay success alone is not an application compatibility assessment. It writes `before.schema.json` and `after.schema.json` without overwriting an existing capture. For a custom type policy, pass the same `typePolicy` to each PostgreSQL migration target so pinned introspection matches application inference and decoding.

Build the candidate application's manifest against the captured after snapshot, and retain the older application's manifest from its own revision against the corresponding before snapshot. Do not compile the current source twice and label one output as the old application.

```sh
pnpm exec typed-sql manifest --schema .typed-sql/review/after.schema.json --out .typed-sql/review/after.queries.json
pnpm exec typed-sql migrate verify --target replay --before-through 001_initial_schema \
  --before .typed-sql/review/before.schema.json --before-manifest artifacts/old-app.queries.json \
  --after .typed-sql/review/after.schema.json --after-manifest .typed-sql/review/after.queries.json
```

The full verification replays again and checks that both supplied snapshots match their declared replay boundaries. It then runs the existing compatibility analyzer with all four artifacts, evaluates both rolling-deployment directions, and writes a redacted report binding migration IDs/hashes, source inventory, snapshot hashes and manifest hashes. `--fail-on none|warning|error` controls the exit policy without suppressing findings. Unknown dependencies remain unknown. A server/schema mismatch cannot be cleared by supplying a freshly introspected snapshot of an unrelated target.

## Inspect drift and reconcile manual DDL

```sh
pnpm exec typed-sql migrate status --target local
pnpm exec typed-sql migrate drift --target local
```

Captured evidence also records persistent database encoding, default collation/ctype, locale provider, ICU or builtin locale/rules and collation version where available. The target and replay database must agree on this versioned environment evidence. Database names and transient session settings are excluded, so changing a session timezone is not recorded as a permanent schema change. Missing or incompatible required evidence blocks execution.

Native migration drift compares the live schema to the independent expected migration head. The top-level `typed-sql drift` compares the application snapshot to live introspection. Regenerating that application snapshot cannot clear unexpected migration drift. Added columns, tables and indexes block just as removals and changes do; unknown catalog coverage also blocks.

Remove an unintended manual change through separately reviewed SQL, or capture its exact intended effect in a new ordinary migration. Declare local reconciliation intent using qualified catalog keys:

```ts
import { defineMigration } from '@typed-sql/migrations';
import { sql } from '@typed-sql/postgres';
import { migrationCatalogKey } from '@typed-sql/postgres/migrations';

export default defineMigration({
  id: '004_capture_manual_status',
  reconciliation: {
    reason: 'Capture the reviewed emergency column addition',
    expectedObjects: [migrationCatalogKey('column', 'public', 'accounts', 'status')],
  },
  up: [sql`alter table public.accounts add column status text`],
  irreversibleReason: 'Dropping the existing column would discard application data.',
});
```

```sh
pnpm exec typed-sql migrate reconcile plan --target local --to 004_capture_manual_status --out .typed-sql/migrations/reconcile.json
pnpm exec typed-sql migrate reconcile apply --target local --plan .typed-sql/migrations/reconcile.json --reason 'Reviewed emergency DDL'
```

Independent replay must produce exactly the complete current managed schema, and the declared object keys must cover exactly its changes. Reconciliation records an explicit already-satisfied origin without rerunning DDL. On a clean database, the same migration executes normally. Partial effects, unrelated drift and changed evidence block adoption.

Schema-only reconciliation accepts a narrow adapter-validated DDL subset: simple table creation, column addition without a default and ordinary column indexes. It rejects DML, CTAS, ADD COLUMN defaults, function defaults and unsupported expressions; schema equality cannot prove historical data changes. Adding a column and later setting its default can leave different existing row values from adding it with that default in one statement. DDL event triggers can have external effects, so adoption does not establish historical data equivalence. Long-running row backfills are separate work.

## Baseline an existing database

Author a reproducible initial schema prefix and independently replay it. Use `reconcile plan` to capture the existing target plus replay evidence, then adopt the prefix explicitly:

```sh
pnpm exec typed-sql migrate baseline --target local --through 001_initial_schema --evidence .typed-sql/migrations/baseline.json --reason 'Reviewed initial schema adoption'
```

Baseline requires untouched native history and an exact full schema match. It records baseline origin, never pretends that every historical statement ran, and does not prove data equivalence. It uses the same narrow schema-only eligibility rules and target lock as reconciliation.

## Reverse or recover explicitly

```sh
pnpm exec typed-sql migrate plan --target local --direction down --to 001_initial_schema --out .typed-sql/migrations/down.json
pnpm exec typed-sql migrate revert --target local --to 001_initial_schema --plan .typed-sql/migrations/down.json
```

Down operates on the contiguous applied suffix in reverse order. A missing down blocks reversal; no down runs automatically after an up failure. Compensation cannot restore deleted data. Original successful hashes remain immutable through later reapplication.

For unknown outcomes, inspect actual effects before `migrate resolve`. `migrate status --json` includes blocked-state diagnostics and a `resolutionEvidence` template for each uncertain attempt. Save the selected template and set `effectsVerified: true` only after inspection. Resolution evidence binds `attemptId`, `migrationId`, `hash`, `historyHash`, `catalogHash`, `targetHash` and explicit `effectsVerified: true`. The runner compares the live catalog to the immutable before/expected catalog retained with the attempt; the operator attests to data effects separately. `confirm-applied` requires complete effects; `confirm-not-applied` requires absent or fully reversed effects. Neither action executes repair SQL or retries work.

```sh
pnpm exec typed-sql migrate resolve --target local --evidence inspection.json --action confirm-not-applied --reason 'Inspected and reversed partial effects'
```

Plans bind target, history, schema, policy, operations and source hashes and are revalidated under the lock. `--out` writes a private executable bundle with restrictive file permissions; it contains SQL and values and is distinct from the redacted report printed to stdout. Keep bundles under ignored `.typed-sql/`, and transport them deliberately in CI. A missing/stale bundle needs a new plan. Production execution requires explicit `--yes`.

Use `--json` for versioned reports and stable diagnostic codes. Database execution, generation and TypeScript checking have distinct outcomes; generation failure never implies a committed migration rolled back.
