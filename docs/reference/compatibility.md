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
| PostgreSQL | PostgreSQL grammar and catalog provider | PostgreSQL 18.4 |
| `pg` | Application-owned driver loaded by `@typed-sql/postgres/pg` | `pg` 8.23.0 |
| MySQL | Grammar targets MySQL 8.4 LTS | MySQL 8.4.11 |
| `mysql2` | Application-owned driver loaded by `@typed-sql/mysql/mysql2` | `mysql2` 3.24.1 |
| SQLite preview | SQLite grammar and PRAGMA catalog provider | SQLite 3.50.4 through Node 24.10.0 |
| `node:sqlite` | Built-in adapter loaded by `@typed-sql/sqlite/node-sqlite`; Node 22.13 or newer | Node 24.10.0 |

Driver configurations that change decoded value shapes can violate static types. The adapters own or reject those settings as documented in [Database type mappings](./type-mappings.md).

## Package stability

| Surface | Status |
| --- | --- |
| `core`, `opentelemetry`, `ast`, `schema`, `config`, `compiler`, `conformance`, `postgres`, `mysql`, `cli` | Stable package contract |
| `ts-bridge`, `language-server`, `sqlite` | Experimental while their preview contracts are exercised |
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

PostgreSQL, MySQL, and the SQLite preview implement the current typed-sql dialect contract. A grammar's `grammarVersion` describes its snapshot and resolution semantics independently from the package version. Generated snapshots record that version, and the grammar rejects incompatible snapshots.

`@typed-sql/conformance` versions its fixture contract independently through
`GRAMMAR_CONFORMANCE_VERSION`. Grammar packages should run the public suite before publishing and
when upgrading typed-sql. A capability is supported only when its positive probe passes; unsupported
features must have a diagnostic probe and fail closed.
