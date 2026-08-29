---
title: Live verification
description: Compare offline compiler evidence with native database prepare metadata and cache a reproducible proof.
---

# Live verification

typed-sql normally works from a checked-in schema snapshot. That keeps `tsc`, editor hovers, and manifest generation fast, deterministic, and independent of a database connection. Live verification is an opt-in CI or release check that asks the database to prepare each safe manifest variant and compares its native metadata with the compiler's evidence.

It does not replace offline inference. It adds database-backed proof for extension types, overload resolution, coercions, and server-version differences.

## Configure an adapter

The grammar package owns the native adapter, while the application owns the driver and connection settings.

```ts
import { defineConfig } from "@typed-sql/core";
import { postgres, typePolicy } from "@typed-sql/postgres";
import { createPgLiveVerifier, pg } from "@typed-sql/postgres/pg";

const connectionString = () => process.env.DATABASE_URL!;

export default defineConfig({
  dialect: postgres({ typePolicy }),
  schema: {
    file: "generated/db/schema.json",
    provider: pg({ connectionString, typePolicy }),
  },
  outDir: "generated/db",
  projects: ["tsconfig.json"],
  manifest: { outFile: ".typed-sql/queries.json" },
  verification: {
    live: createPgLiveVerifier({ connectionString, typePolicy }),
    proofFile: ".typed-sql/verification.json",
    concurrency: 4,
  },
});
```

For MySQL, install `mysql2` and use `createMySql2LiveVerifier()` from `@typed-sql/mysql/mysql2`. Neither grammar package installs its driver.

Creating an adapter does not connect. Only `typed-sql verify --live` opens the database, so ordinary compilation and cached verification remain offline.

## Generate and verify

```sh
pnpm exec typed-sql manifest
pnpm exec typed-sql verify --live
```

The live command reloads project sources and refuses a stale manifest before connecting. SQL is reconstructed transiently in memory and matched to manifest variants by fingerprint. It is sent only to the configured database adapter and is never written to the proof.

After a successful live run, CI can validate the same proof without a connection:

```sh
pnpm exec typed-sql verify
```

Cached verification rejects a missing, malformed, or stale proof. Regenerate the manifest before checking the proof so source, schema, type-policy, compiler, and grammar changes invalidate it.

## Safety model

The default verifier accepts only evidence-backed `read` and `write` operations. It invokes the database's prepare/describe mechanism but never executes the statement and never supplies parameter values:

- PostgreSQL uses session-local `PREPARE`, reads `pg_prepared_statements`, then always `DEALLOCATE`s. PostgreSQL 18 exposes both parameter and result types. Older servers that do not expose result types are reported as incomplete instead of being treated as verified.
- MySQL uses binary `COM_STMT_PREPARE` metadata through the application-installed `mysql2` adapter,
  resolves origin columns against the live `information_schema.columns` catalog, then closes the
  prepared statement without `COM_STMT_EXECUTE`. Origin lookup preserves catalog types such as enum
  value sets that the prepare packet otherwise reports only as a string class. Parameter comparison
  is directional: a compiler-enforced literal subset is compatible with the broader native input
  class, while result columns still require native output evidence assignable to the inferred type.
- DDL, transaction-control, unknown, dynamic, stale, and unsupported queries are explicit skips or errors. They are never silently marked verified.

Prepare metadata does not prove runtime cardinality, business constraints, permissions for every production role, or query-plan quality.

## Proof artifact

`.typed-sql/verification.json` is canonical, versioned JSON containing:

- the manifest hash, dialect, neutral verifier version, and grammar-adapter version;
- the server version and sorted non-secret compatibility features;
- a cache key covering every artifact input and the canonical native evidence, so accidental proof edits are stale;
- a source-relative entry for every query or variant;
- native column and parameter evidence, exact mismatches, explicit skips, and redacted failures.

The proof has no timestamp, so identical inputs and evidence produce byte-identical output. It never contains SQL text, parameter values, database URLs, credentials, absolute paths, or driver error messages.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every eligible variant verified and cached proof is current. |
| `1` | A mismatch, native failure, stale artifact, missing proof, or configuration failure occurred. |
| `2` | The proof is current but contains explicit skipped or unsupported entries. |

Human output points to the source location and prints compiler evidence beside database evidence. The JSON proof is the machine-readable report for CI and later compatibility tooling.

## CI containers

Use the same schema initialization as the application and a disposable database account with only the permissions needed to resolve referenced objects. The repository's PostgreSQL 18 and MySQL 8.4 E2E packages build digest-pinned containers, generate snapshots and manifests, run live verification, verify the offline cache, and assert that no statement values or mutations are sent.
