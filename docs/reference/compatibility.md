---
title: Compatibility
description: Supported runtimes, TypeScript compiler paths, database dialects, drivers, and experimental editor surfaces.
---

# Compatibility

Compatibility has two meanings in typed-sql:

- **Supported** identifies a required or documented product contract.
- **Tested** identifies the exact environment exercised by protected CI.

A tested version does not imply that every older or newer version is supported. A supported range does not imply that every version in the range runs in every CI job.

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

Driver configurations that change decoded value shapes can violate static types. The adapters own or reject those settings as documented in [Database type mappings](./type-mappings.md).

## Package stability

| Surface | Status |
| --- | --- |
| `core`, `ast`, `schema`, `config`, `compiler`, `postgres`, `mysql`, `cli` | Stable package contract |
| `ts-bridge`, `language-server` | Experimental while they depend on preview TypeScript APIs |
| VS Code and Zed integrations | Experimental distribution |

Every public package records its classification in `typedSql.releaseTrack`.

## Editor bridge

The language server installs an exact TypeScript preview as an internal dependency and runs it behind a process boundary. Applications do not install or configure that preview directly. The bridge can change with TypeScript preview APIs without changing the grammar, generated snapshot, or query contract.

The language server replaces the normal TypeScript server for a configured project. Running a second TypeScript server can show the safe baseline `Query<unknown>` beside typed-sql's transformed hover.

## Grammar and snapshot compatibility

PostgreSQL and MySQL implement the current typed-sql dialect contract. A grammar's `grammarVersion` describes its snapshot and resolution semantics independently from the package version. Generated snapshots record that version, and the grammar rejects incompatible snapshots.
