---
title: Compatibility
pageType: reference
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
| SQL module declaration consumers | Exactly 6.0.3 or 7.0.2 for generated SQL modules | 6.0.3 framework consumers and 7.0.2 standalone consumers; inline inference uses the correctness path below |
| TypeScript correctness path | Exactly 7.0.2 | 7.0.2 on every tested Node line |
| TypeScript editor backend | Exactly `7.1.0-beta`, installed inside the bridge | The pinned preview on every tested Node line |
| typed-sql editor protocol | Version 1; the existing unversioned client shape is treated as version 1 | Versioned and unversioned v1 clients |
| Module format | ESM packages with exported JavaScript and declarations | NodeNext ESM consumers and packed package exports |
| Package manager | Any package manager that honors package exports | Repository checks use pnpm |

TypeScript 7.0 does not provide the legacy `tsserver.js` entrypoint expected by some editors. CLI checking and compiler transforms are authoritative and do not depend on that file. Other TypeScript compiler/backend patches are not implicitly supported: each exact compiler or preview patch enters the compatibility matrix as a non-blocking canary before it can replace a supported target.

`typed-sql check` verifies the application-installed TypeScript package before opening its in-memory overlay. The editor bridge
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
| `pg` | Application-owned driver loaded by `@typed-sql/postgres/pg` | `pg` 8.23.1 |
| MySQL | MySQL 8.4 and 9.7 LTS grammar and catalog provider; patch-compatible within each LTS series | MySQL 8.4.11 and 9.7.2 across default, lexical-mode, and unsigned-arithmetic profiles; MySQL 26.7.0 as a non-blocking innovation canary |
| `mysql2` | Application-owned driver loaded by `@typed-sql/mysql/mysql2` | `mysql2` 3.24.6 |
| SQLite | SQLite 3.39.0–3.54.1 grammar and PRAGMA catalog provider; unknown newer libraries are conservative | Source-built SQLite 3.39.0 and 3.54.1, every supported Node line's bundled library, with exact 3.54.1 release coverage |
| `node:sqlite` | Built-in adapter loaded by `@typed-sql/sqlite/node-sqlite`; Node 22.13+, 24, and 26 | Node 22.13.0 and current Node 22, 24, and 26 lines |
| [SQL Server](../dialects/sqlserver.md) | Boxed engine majors 14–17, with each engine's supported compatibility levels 140–170 | 14.0.3560.2, 15.0.4500.2, 16.0.4305.5 and 17.0.5035.5; ten engine/compatibility combinations |
| `koffi` | Application-owned direct ODBC bridge loaded by `@typed-sql/sqlserver/odbc`; exact 3.3.7 on Linux x64 | Counted value transport with ODBC 18.7.1.1 and unixODBC 2.3.12 |
| `msnodesqlv8` | Explicit `@typed-sql/sqlserver/msnodesqlv8` compatibility adapter; restricted text result families | 6.2.2 with ODBC 18.7.1.1 and unixODBC 2.3.12 on native Linux x64 |
| [DuckDB](../dialects/duckdb.md) | Exact engine targets 1.5.6 and 2.0.0; intermediate and future versions are conservative | Both genuine native engines, each in a separate process |
| `@duckdb/node-api` | Application-owned official Node SDK loaded by `@typed-sql/duckdb/node-api` | 1.5.6-r.2 with engine 1.5.6; 2.0.0-r.1 with engine 2.0.0 |

Driver configurations that change decoded value shapes can violate static types. The adapters own or reject those settings as documented in [Database type mappings](./type-mappings.md).

## Package stability

| Surface | Status |
| --- | --- |
| `core`, `opentelemetry`, `ast`, `schema`, `config`, `compiler`, `conformance`, `postgres`, `mysql`, `sqlite`, `sqlserver`, `duckdb`, `cli`, `adapters`, `build`, `migrations` | Stable package contract |
| `ts-bridge`, `language-server` | Experimental while their preview contracts are exercised |
| VS Code and Zed integrations | Experimental distribution |

Every public package records its classification in `typedSql.releaseTrack`.

## Editor bridge

The language server installs an exact TypeScript preview as an internal dependency and runs it behind a process boundary. Applications do not install or configure that preview directly. The bridge can change with TypeScript preview APIs without changing the grammar, generated snapshot, or query contract.

In VS Code, Microsoft's native TypeScript client can launch the proxy through the packaged editor SDK, preserving a single language provider. The standalone proxy requires explicit provider selection. Running an independent second TypeScript server can show the safe baseline `Query<unknown>` beside typed-sql's transformed hover.

The bridge uses the public `async`, `ast`, and `fs` entrypoints in the exact TypeScript 7.1 beta.
`ts-bridge`, `language-server`, and both editor integrations remain experimental while beta API
compatibility and editor-host behavior are verified. The beta dependency and its API-specific code
remain isolated from grammar and stable packages.

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

## Browser SQLite persistence

The official SQLite Wasm OO1 adapter is exercised with `@sqlite.org/sqlite-wasm`
3.54.1-build1 (SQLite 3.54.1) in Chromium. This is an exact tested driver version,
not a promise of compatibility with every Wasm SDK release.

| Backend | Execution context | Browser requirements | Persistence verification |
|---|---|---|---|
| Memory | Main thread or worker | WebAssembly and BigInt | Adapter execution suite |
| `opfs` | Dedicated worker | OPFS, SharedArrayBuffer, cross-origin isolation | Connection reopen, worker restart, page reload, concurrent-worker lock recovery |
| `opfs-sahpool` | Dedicated worker | OPFS synchronous access handles; exclusive pool ownership | Connection reopen, worker restart, page reload, conflicting initialization and handoff |

Browser storage availability depends on the browser, origin and storage permissions.
The application selects the backend explicitly and surfaces initialization failures.
See [SQLite Wasm persistence](../guides/sqlite-wasm.md) for setup and ownership.
