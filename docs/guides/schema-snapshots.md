---
title: Schema snapshots and drift
description: Generate deterministic database metadata, review schema changes, and detect catalog or type-policy drift.
---

# Schema snapshots and drift

typed-sql analyzes queries against a generated snapshot rather than contacting the database during every editor or compiler request.

## Generate a snapshot

```sh
pnpm exec typed-sql generate
```

The configured provider introspects the selected schemas and writes deterministic metadata to `schema.file`. Generated output records:

- the dialect and grammar version;
- database server version;
- tables, views, columns, defaults, enums, domains, and supported functions;
- database-to-TypeScript mappings;
- the schema hash and type-policy hash.

Commit the snapshot. It gives application code, CI, and editors the same catalog contract and makes schema changes reviewable without database access.

## Detect drift

```sh
pnpm exec typed-sql drift
```

Drift compares the committed snapshot with the live catalog and configured type policy. A database migration or policy change requires regeneration even when application SQL has not changed.

## Check source against the snapshot

```sh
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
```

`check` extracts static SQL, analyzes it with the configured grammar and snapshot, applies the inferred overlay in memory, and asks TypeScript to validate the result.

## Credentials

Generated files never contain connection strings. Keep credentials in environment variables or the executable config callback. Use a least-privilege, read-only introspection account where possible.

Do not import application APIs from the generated folder. Application code imports `sql` and `typePolicy` from the dialect package; generated output is schema metadata for analysis and review.
