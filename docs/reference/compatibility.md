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

| Surface | Contract | Tested target |
| --- | --- | --- |
| Node.js | 22.11 or newer | 22.11.0, current Node 22, 24, and 26 lines for compiler/editor integration |
| TypeScript correctness path | Exactly 7.0.2 | 7.0.2 on every tested Node line |
| TypeScript editor backend | Exactly `7.1.0-dev.20260824.1`, installed inside the bridge | The pinned preview on every tested Node line |
| typed-sql editor protocol | Version 1; the existing unversioned client shape is treated as version 1 | Versioned and unversioned v1 clients |
| Module format | ESM packages with exported JavaScript and declarations | NodeNext ESM consumers and packed package exports |
| Package manager | Any package manager that honors package exports | Repository checks use pnpm |

TypeScript 7.0 does not provide the legacy `tsserver.js` entrypoint expected by some editors. CLI checking and compiler transforms are authoritative and do not depend on that file. Other TypeScript patches are not implicitly supported: each exact compiler or preview patch enters the compatibility matrix as a non-blocking canary before it can replace a supported target.

`typed-sql check` verifies `tsc --version` before writing its temporary overlay. The editor bridge
similarly verifies its bundled preview package before loading a project. An unsupported patch stops
with an actionable compatibility error rather than exercising an untested compiler API.

Run `typed-sql doctor` to inspect the active Node.js and TypeScript versions, grammar and schema
identities, redacted server evidence, installed editor packages, and protocol window. `--json`
provides deterministic automation output; `--protocol <version>` checks a specific editor client.
The report excludes setting values, schema expressions, source text, credentials, and absolute paths.

## Databases and drivers

| Surface | Product contract | Tested environment |
| --- | --- | --- |
| PostgreSQL | PostgreSQL 14–18 grammar and catalog provider; patch-compatible within each major | PostgreSQL 14.24, 15.19, 16.15, 17.11, and 18.6; PostgreSQL 19beta3 as a non-blocking canary |
| `pg` | Application-owned driver loaded by `@typed-sql/postgres/pg` | `pg` 8.23.0 |
| MySQL | MySQL 8.4 and 9.7 LTS grammar and catalog provider; patch-compatible within each LTS series | MySQL 8.4.11 and 9.7.2 across default, lexical-mode, and unsigned-arithmetic profiles; MySQL 26.7.0 as a non-blocking innovation canary |
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

The typed-sql-specific editor protocol is independently versioned from LSP and the package version.
Protocol v1 is the current accepted window; clients that predate the version field use the same v1
shape. Removing an accepted protocol version requires a language-server major release and at least
one language-server minor of notice.

Versioned clients negotiate the optional `analysis-identity`, `diagnostic-fixes`, and `status`
capabilities during LSP initialization. A client outside the accepted version window is rejected
with an upgrade instruction before workspace setup. Diagnostics carrying an analysis identity are
valid only for the matching source hash/version, project generation and config hash,
grammar/capability fingerprint, schema hash, and type-policy hash.

Editor parity covers PostgreSQL, MySQL, SQLite, and the public synthetic third-party grammar. The
same serialized analysis result supplies inferred rows, ordered parameter tuples, nullability,
diagnostics, insertions, and source/transformed/interpolation spans in batch and editor modes.
Ordinary, multi-file, multi-project, and multi-root workspaces use the same result contract.

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
