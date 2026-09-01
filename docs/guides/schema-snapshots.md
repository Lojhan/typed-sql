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
- normalized, grammar-owned server evidence: product, opaque `versionKey`, semantic settings, extensions, and compile options;
- namespaces and relations, including table/view kind, ordered columns, defaults, generated and identity behavior, and write eligibility;
- primary, unique, foreign-key, check, and exclusion constraints, plus indexes and their expression or predicate fingerprints;
- scalar, enum, domain, composite, range, multirange, collection, and opaque type identities;
- functions, procedures, aggregates, and window routines, including ordered arguments, result shape, volatility, determinism, and data-access evidence;
- database-to-TypeScript mappings;
- the schema hash and type-policy hash.

Commit the snapshot. It gives application code, CI, and editors the same catalog contract and makes schema changes reviewable without database access.

Inspect how that evidence changes grammar support without contacting the database:

```sh
pnpm exec typed-sql capabilities
```

Every declared capability is reported as `exact`, `conservative`, or `unsupported`, with the
server-version, setting, feature, policy, and grammar evidence used for that decision. Missing or
unparseable evidence never selects the newest server behavior. Regenerate the snapshot after a
server upgrade, extension change, SQLite library rebuild, or semantic setting change such as MySQL
`sql_mode`.

## Detect drift

```sh
pnpm exec typed-sql drift
```

Drift compares the committed snapshot with the live catalog and configured type policy. Its result
identifies changed servers, namespaces, types, relations, routines, extensions, and type policy
without including catalog values or expressions. A database migration or policy change requires
regeneration even when application SQL has not changed.

Generated snapshots use schema format 2. Format 1 remains readable as a conservative migration
input, but evidence it never recorded stays unknown and cannot enable v2-only analysis. Generation
always writes format 2, so regenerate before relying on constraints, write eligibility, complete
routine overloads, or object-level compatibility reports.

## Check source against the snapshot

```sh
pnpm exec typed-sql check --file src/query.ts --project tsconfig.json
```

`check` extracts static SQL, analyzes it with the configured grammar and snapshot, applies the inferred overlay in memory, and asks TypeScript to validate the result.

## Credentials

Generated files never contain connection strings. Server evidence is restricted to grammar-allowlisted
scalar settings and sorted, non-secret feature identifiers; raw server errors and connection
configuration are excluded. Keep credentials in environment variables or the executable config
callback. Use a least-privilege, read-only introspection account where possible.

Do not import application APIs from the generated folder. Application code imports `sql` and `typePolicy` from the dialect package; generated output is schema metadata for analysis and review.
