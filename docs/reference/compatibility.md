---
title: Compatibility
description: Supported runtimes, TypeScript compiler paths, database dialects, drivers, and experimental editor surfaces.
---

# Compatibility

Compatibility has two meanings in typed-sql:

- **Supported** identifies a required or documented product contract.
- **Tested** identifies the exact environment exercised by protected CI.

A tested version does not imply that every older or newer version is supported. A supported range does not imply that every version in the range runs in every CI job.

For package-major, grammar, snapshot, manifest, verification, plan, compatibility, and adapter
version boundaries, see [Upgrade from typed-sql v1](../guides/upgrading-from-v1.md).

## Runtime and compiler

| Surface | Contract |
| --- | --- |
| Node.js | 22.11 or newer |
| TypeScript correctness path | Exactly 7.0.2 |
| Module format | ESM packages with exported JavaScript and declarations |
| Package manager | Any package manager that honors package exports; repository examples use pnpm |

TypeScript 7.0 does not provide the legacy `tsserver.js` entrypoint expected by some editors. CLI checking and compiler transforms are authoritative and do not depend on that file.

## Databases and drivers

| Surface | Product contract | Tested environment |
| --- | --- | --- |
| PostgreSQL | PostgreSQL 14–18 grammar and catalog provider; patch-compatible within each major | PostgreSQL 14.24, 15.19, 16.15, 17.11, and 18.6; PostgreSQL 19beta3 as a non-blocking canary |
| `pg` | Application-owned driver loaded by `@typed-sql/postgres/pg` | `pg` 8.23.0 |
| MySQL | Grammar targets MySQL 8.4 LTS | MySQL 8.4.11 |
| `mysql2` | Application-owned driver loaded by `@typed-sql/mysql/mysql2` | `mysql2` 3.24.1 |
| SQLite | SQLite 3.39.0–3.53.4 grammar and PRAGMA catalog provider; unknown newer libraries are conservative | Source-built SQLite 3.39.0 and 3.53.4, every supported Node line's bundled library, and a non-blocking 3.54.0 canary |
| `node:sqlite` | Built-in adapter loaded by `@typed-sql/sqlite/node-sqlite`; Node 22.13+, 24, and 26 | Node 22.13.0 and current Node 22, 24, and 26 lines |

Driver configurations that change decoded value shapes can violate static types. The adapters own or reject those settings as documented in [Database type mappings](./type-mappings.md).

## Package stability

| Surface | Status |
| --- | --- |
| `core`, `opentelemetry`, `ast`, `schema`, `config`, `compiler`, `conformance`, `postgres`, `mysql`, `sqlite`, `cli` | Stable package contract |
| `ts-bridge`, `language-server` | Experimental while their preview contracts are exercised |
| VS Code and Zed integrations | Experimental distribution |

Every public package records its classification in `typedSql.releaseTrack`.

## Editor bridge

The language server installs an exact TypeScript preview as an internal dependency and runs it behind a process boundary. Applications do not install or configure that preview directly. The bridge can change with TypeScript preview APIs without changing the grammar, generated snapshot, or query contract.

The language server replaces the normal TypeScript server for a configured project. Running a second TypeScript server can show the safe baseline `Query<unknown>` beside typed-sql's transformed hover.

The TypeScript 7.1 package currently publishes the native program APIs used by the bridge through
explicit `unstable/*` entrypoints. For that reason `ts-bridge`, `language-server`, and both editor
integrations remain experimental even though the CLI/compiler path is stable. The preview dependency
and its API-specific code remain isolated from grammar and stable packages.

## Grammar and snapshot compatibility

PostgreSQL, MySQL, and SQLite implement the current typed-sql dialect contract. A grammar's `grammarVersion` describes its snapshot and resolution semantics independently from the package version. Generated snapshots record that version, and the grammar rejects incompatible snapshots.

`@typed-sql/conformance/v2` uses permanent, feature-addressable probe IDs and independently versioned
probe/report formats. Grammar packages should run the public suite before publishing and when upgrading
typed-sql. A capability is supported only when its positive probe passes; unsupported features must
have a diagnostic probe and fail closed. The package-root `GRAMMAR_CONFORMANCE_VERSION` contract is the
deprecated typed-sql 2.x bridge and is removed with the rest of conformance v1 in typed-sql 3.0.

The boolean `DialectPlugin.capabilities` map remains an additive compatibility view for the current
major line. New tooling uses `resolveCapabilities(snapshot, policy?)` to distinguish exact,
conservative, and unsupported states from normalized server evidence. Boolean-only third-party
grammars continue to load, but their `true` values resolve conservatively until they implement the
versioned contract.
