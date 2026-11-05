---
title: DuckDB
pageType: reference
description: DuckDB SQL analysis, qualified engine and Node SDK versions, exact nested value policies, catalog evidence, and native execution.
---

# DuckDB

`@typed-sql/duckdb` analyzes DuckDB SQL from saved catalog evidence. Applications import `sql` from
this grammar. The native Node SDK is an application dependency accessed through the explicit
`@typed-sql/duckdb/node-api` entrypoint.

## Engine and driver compatibility

Support consists of these exact qualified targets. It does not include intermediate or newer releases.

| DuckDB engine | Official Node SDK | Grammar and native execution |
| --- | --- | --- |
| 1.5.6 | `@duckdb/node-api` 1.5.6-r.2 | Qualified |
| 2.0.0 LTS | `@duckdb/node-api` 2.0.0-r.1 | Qualified |
| 1.4 and earlier | Any | Unsupported |
| Other, future, or prerelease versions | Any | Conservative analysis; native adapter rejects execution |

Use the SDK release corresponding to the engine. An injected connection and `sdkImporter` must
come from the same SDK module. Keep distinct SDK/native-engine installations in separate processes.
DuckDB Wasm, MotherDuck, remote transports and the legacy `duckdb` Node driver are separate adapters;
the native adapter does not claim their compatibility.

## Entrypoints

| Import | Purpose |
| --- | --- |
| `@typed-sql/duckdb` | `sql`, grammar factory, policies, native type helpers, catalog and snapshot provider contracts |
| `@typed-sql/duckdb/query` | Lightweight query construction and native `$N` rendering |
| `@typed-sql/duckdb/runtime` | Driver-neutral native connection and execution contracts |
| `@typed-sql/duckdb/node-api` | Lazy official SDK loading, catalog provider and executable adapter |

The root and query entrypoints are browser safe and do not import the driver. Installing the grammar
does not install the SDK. The SDK is loaded when the explicit native adapter is constructed.

## Native values

The default policy preserves exact values across compile-time inference and runtime decoding.

| DuckDB type | Default JavaScript value |
| --- | --- |
| Small signed/unsigned integers, `FLOAT`, `DOUBLE` | Finite `number`; unsafe integer values are rejected |
| `BIGINT`, `UBIGINT`, `HUGEINT`, `UHUGEINT`, `BIGNUM` | `bigint` |
| `DECIMAL(p,s)` | Exact decimal `string`, retaining scale |
| Date, time and timestamp families | Precision-preserving `string`; supported date/timestamp infinities remain explicit |
| `BOOLEAN`, `VARCHAR`, `UUID`, `BIT` | `boolean` or `string` |
| `BLOB` | Owned `Uint8Array` copy |
| `INTERVAL` | `{ months: number; days: number; micros: bigint }` |
| `JSON` | JSON text `string`; `unknown` and `JsonValue` are explicit policy alternatives |
| `ENUM` | String literal union |
| `LIST` | Readonly array of nullable elements |
| Fixed `ARRAY` | Readonly tuple through length 64; readonly array above that, with exact runtime length validation |
| `STRUCT` | Required named fields, with independently nullable field values |
| Unnamed `TUPLE` | Readonly positional tuple, with nullable entries |
| `MAP` | Readonly ordered `[key, value]` entries, retaining native key types |
| `UNION` | Discriminated `{ tag, value }` members |

A nullable column additionally permits SQL `null`. Nested container nullability is independent from
its elements or fields. MAP keys cannot themselves be SQL NULL; composite keys can contain nullable
members. Structural key equality and duplicate-key checks retain nested native identity.

For a `UNION`, `{ tag: "number", value: null }` differs from a SQL NULL union. The adapter preserves
that distinction even through nested LIST/ARRAY/STRUCT/TUPLE/MAP values. The qualified SDK releases
cannot directly construct an active NULL union payload. The adapter uses a structural parameter
transport with typed SQL-NULL witnesses to retain the full native target type and active tag. This
also supports unnamed tuple metadata on 1.5.6, whose SQL parser cannot spell a `TUPLE(...)` type cast.
It does not change the number of logical parameters or interpolate application values into SQL.

Unproved `VARIANT` codecs and unknown physical types fail closed. Selecting a type policy that returns
`unknown` does not authorize the native adapter to return live SDK wrappers after releasing a result.

## SQL and catalog evidence

The grammar owns DuckDB coercions and builtin overloads, analytical joins, CTEs, set operations,
aggregates and windows, `QUALIFY`, recursive projection `UNNEST`, fixed nested shapes, collection
lambdas, and `INSERT`/`UPDATE`/`DELETE ... RETURNING`. LIST comprehensions and STRUCT/MAP constructors
retain their native structure. DuckDB 2.0 uses `lambda x: expression`; legacy single-arrow lambdas are
accepted only for compatible 1.5.6 settings. Native JSON arrows remain JSON extraction operators.

The provider records catalog/schema identities, search paths, relations, constraints, types,
routines/macros, loaded extensions, engine version and semantic settings. Quoted identifiers follow
DuckDB's ASCII case folding. Qualification and search-path evidence determine relation lookup.
Dynamic external schemas and unsupported SQL receive diagnostics rather than fabricated columns.

The native adapter captures actual connection evidence at construction and rechecks it under each
operation lease. A supplied `compatibilitySnapshot` additionally checks against its recorded server
evidence. Changed timezone, search path, extensions or other recorded semantic settings are rejected.
The supported policy requires ordinary division, Gregorian dates, preserved identifier case, and
1.5.6's modern implicit-casting behavior. Injected connections are validated without silently changing
their settings.

## Execution and ownership

`createNodeDuckDBDatabase` exposes `all`, `execute`, `one`, `maybeOne`, `transaction`, `batch`, `stream`,
`prepare`, `unprepare` and `close`. Queries need compiled runtime value plans, supplied by the stable
[build integrations](../integrations/index.md). Running an untransformed inline template through a
TypeScript runner alone does not supply such a plan.

Root batches are atomic. A batch inside a transaction reuses that transaction. Transaction callbacks
must await operations and consume or close started streams; unfinished work is drained, then the
transaction reports misuse and rolls back. Nested transactions are rejected.

Cancellation and absolute deadlines use a scoped native interrupt. The adapter drains in-flight
work before reusing the connection. Native statements and results close deterministically, including
abandoned streams and validation failures. Failed cleanup quarantines the shared connection.
Result validation runs lazily for each consumed streamed row with a result-wide row index.
Observers receive redacted fingerprints and lifecycle events, with error causes included only when
explicitly requested through the shared observer contract.

A path-created instance and connection are owned and closed by the adapter. Injected resources remain
application owned unless ownership is explicitly transferred. `close()` releases owned file locks;
applications must also close any independently retained native connections or instances.

Start with the [quickstart](../getting-started/duckdb.md), then explore
[nested and analytical examples](../examples/duckdb.md).
