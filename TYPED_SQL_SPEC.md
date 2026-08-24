# typed-sql specification

Status: 1.0 release-candidate contract. Its gates and evidence are tracked in
[`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Goal

Given a static SQL template, an installed dialect plugin, and a versioned schema snapshot,
typed-sql computes a precise immutable result-row type and makes that type visible to TypeScript 7,
the CLI, and editors without changing the runtime SQL authoring model.

## Safety invariants

1. Unsupported, dynamic, invalid, or ambiguous SQL never produces `any` or an optimistic row.
2. The application explicitly installs its dialect and driver; no driver is a regular dependency
   of core, compiler, config, CLI, schema, language server, or grammar roots.
3. SQL values remain values in a grammar-neutral IR until a selected renderer emits placeholders.
4. Generated artifacts contain schema metadata only—never application APIs, credentials, clients,
   pools, or driver imports.
5. CLI, CI, and editors call the same dialect `analyze` contract and use the same diagnostics.
6. Snapshot format, dialect contract, diagnostic codes, and type policy are versioned boundaries.

## Packages

| Package | Contract |
| --- | --- |
| `@typed-sql/core` | `Query<Row>`, `sql`, neutral IR/renderer, database and dialect interfaces. |
| `@typed-sql/ast` | Current PostgreSQL tokenizer/parser implementation. It is not a core dependency. |
| `@typed-sql/schema` | Dialect-neutral snapshot validation, deterministic hashes/generation, drift. |
| `@typed-sql/config` | Discovery/loading of `typed-sql.config.*`. |
| `@typed-sql/postgres` | PostgreSQL `sql`/policy application API, parser composition, resolver, catalogs, codecs. |
| `@typed-sql/postgres/pg` | Lazy adapter for application-owned `pg`. |
| `@typed-sql/mysql` | MySQL `sql`/policy application API, parser composition, resolver, catalogs, codecs. |
| `@typed-sql/mysql/mysql2` | Lazy adapter for application-owned `mysql2`. |
| `@typed-sql/compiler` | Neutral TypeScript source scanning and dialect dispatch. |
| `@typed-sql/cli` | Config-driven generate/check/drift commands. |
| `@typed-sql/ts-bridge` | TypeScript 7 overlay and native preview transport. |
| `@typed-sql/language-server` | Grammar-neutral LSP proxy configured by the project. |

## Dialect contract v1

A dialect has a stable id/package version, an exact `sqlModule` package entrypoint, default policy,
parameter placeholder function, SQL analysis function, and snapshot validator. `defineConfig`
rejects a different contract version. The compiler recognizes only the configured `sqlModule` and
does not branch on dialect ids or assume `@typed-sql/*` package names.

`analyze(sql, snapshot, policy)` returns resolved columns plus diagnostics. Each resolved column has
a property name, TypeScript type expression, nullability, and source range. Error diagnostics block
type injection. Warnings remain visible without pretending unsupported expressions are known.

## Runtime contract

`Query<Row>` contains branded immutable segments: text, value, or identifier. It contains no
dialect AST and no pre-rendered `$1`/`?` placeholders. A renderer supplies placeholder and quoted
identifier rules. Driver adapters structurally accept pools/clients and may expose a lazy optional
driver subpath; importing the grammar must work without that application dependency installed.

PostgreSQL execution renders `$n`, recursively string-encodes bigint parameters, applies per-query
OID parsers, provides transactions/savepoints, and closes a pool only when it owns that pool.

## Snapshot and generation

Snapshot format 1 records dialect id/version, server version, tables/columns, enums, domains, and
functions. Generated metadata contains generator version plus deterministic schema and policy
SHA-256 hashes. Drift compares canonical current schema/policy hashes with generated metadata.
The generated TypeScript module exports only schema and metadata for inspection; application code
imports `sql` and the default `typePolicy` from its installed dialect root.

The schema package treats type policy as opaque dialect-owned serializable data. PostgreSQL owns
the PostgreSQL policy shape and defaults.

## TypeScript 7 integration

The build compiler is strictly TypeScript 7.0. The semantic bridge uses an exact aliased 7.1 preview
snapshot until the relevant native API stabilizes. It creates an in-memory transformed snapshot,
asks TypeScript for authoritative query/downstream types, and maps all positions to original source.
The checked-in CLI transform is the CI correctness mechanism; editor availability is not required.

## Verification requirements

Compiler-critical packages enforce package-local coverage thresholds with Poku and `@pokujs/c8`.
Contract tests inspect dependency graphs and packed archives. Every public tarball installs in a
temporary consumer where `pg` and `mysql2` are absent and both missing-driver paths are actionable.
The packed real-database E2E is the acceptance authority for PostgreSQL and MySQL live catalogs,
generated developer artifacts, exact downstream TypeScript types, native preview types, execution,
and drift.

The supported SQL surface is normative in
[`docs/POSTGRESQL_SUPPORT.md`](./docs/POSTGRESQL_SUPPORT.md); broader syntax belongs to later
roadmap gates and must fail safely until implemented.
