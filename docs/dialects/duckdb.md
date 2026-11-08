---
title: DuckDB
pageType: reference
description: DuckDB SQL analysis, qualified engine and Node SDK versions, exact nested value policies, catalog evidence, and native execution.
---

# DuckDB

`@typed-sql/duckdb` analyzes DuckDB SQL from saved catalog evidence. Applications import `sql` from
this grammar. The native Node SDK is an application dependency accessed through the explicit
`@typed-sql/duckdb/node-api` entrypoint.

`@typed-sql/duckdb/profile` exports `duckdbProfile()` for [query contract consumption](../guides/query-manifests.md#consume-durable-query-contracts-in-a-compiler-host). It provides grammar mechanics without loading semantic catalogs or introspection providers and contains no analyzer loader. Contextual parameter extraction retains the syntax parser.

`@typed-sql/duckdb` exports the lightweight `sql` tag, runtime plan primitives, renderer and policies. The eager analyzer and previous full grammar exports are available through `@typed-sql/duckdb/analysis`.

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
| `@typed-sql/duckdb` | Lightweight `sql`, rendering, runtime plans and policies |
| `@typed-sql/duckdb/analysis` | Full compatibility analyzer, policies, native types, catalog and snapshot provider |
| `@typed-sql/duckdb/analysis/profiles/1.5.6` and `@typed-sql/duckdb/analysis/profiles/2.0.0` | Portable analyzer with one exact engine catalog |
| `@typed-sql/duckdb/analysis/selected` | Asynchronous `loadDuckDBAnalyzer({ version })` |
| `@typed-sql/duckdb/browser` | Portable grammar factory, policies, parsing, catalog and snapshot validation; no Node services |
| `@typed-sql/duckdb/query` | Lightweight query construction and native `$N` rendering |
| `@typed-sql/duckdb/runtime` | Driver-neutral native connection and execution contracts |
| `@typed-sql/duckdb/node-api` | Lazy official SDK loading, catalog provider and executable adapter |

The browser, selected analyzer and query entrypoints do not import Node services or the driver.
The full analysis entrypoint exports the catalog provider, whose fingerprinting services use Node
APIs. Installing the grammar does not install the SDK. The SDK is loaded when the explicit native
adapter is constructed.

## Select an analyzer catalog

Use a fixed version when the engine target is known:

```ts
import { duckdb } from '@typed-sql/duckdb/analysis/profiles/2.0.0'

const dialect = duckdb()
```

For a configured target, `loadDuckDBAnalyzer({ version: '2.0.0' })` from
`@typed-sql/duckdb/analysis/selected` loads its catalog asynchronously. Both forms retain the
selected version’s function signatures, parameter bindings, implicit casts and common-type rules.
Fixed entrypoints exclude other versions from their import graph. A bundler can emit additional
chunks for the asynchronous loader’s other potential targets.

A selected analyzer requires matching exact `server.versionKey` evidence and the qualified
semantic settings described below. Missing or mismatched evidence produces `TSQ402`;
unsupported loader versions reject loading. Application `sql` imports remain at the grammar root.
The full compatibility analyzer continues to select among all retained catalogs. Selection does
not choose a compact common-function core or remove compatibility catalogs from the installed package.

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
accepted only for compatible 1.5.6 settings. Native JSON arrows remain JSON extraction operators. Escape strings preserve native hex/octal byte
and UTF-8 behavior. The 1.5.6 parser rejects escaped non-ASCII bytes and `\u`/`\U` forms;
queries using these forms receive version diagnostics.

Named function arguments follow the selected engine's binding rules. DuckDB 2.0.0 binds formal
names and rejects unknown names, duplicates and positional arguments after named arguments.
On 1.5.6, ordinary scalar names act as labels; macros and special invocation forms have their own
rules. Generated catalog names drive binding, while quoting preserves the distinction between
keyword syntax and a quoted macro call. Calls whose slot assignment cannot be established receive
a diagnostic. Named table-function options and unavailable default metadata remain subject to the
grammar's qualified function support.

The provider records catalog/schema identities, search paths, relations, constraints, types,
routines/macros, loaded extensions, engine version and semantic settings. Quoted identifiers follow
DuckDB's ASCII case folding. Qualification and search-path evidence determine relation lookup.
Dynamic external schemas and unsupported SQL receive diagnostics rather than fabricated columns. Unaliased expressions use
qualified native display labels. An expression whose versioned label cannot be proven requires an
explicit `AS` alias instead of an invented result property name.

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

## Native vector appends

The `/runtime` entrypoint exports the `duckdbAppender` capability. Obtain it with
`requireAdapterCapability(database, duckdbAppender)` from `@typed-sql/core`, then call
`append(rowQuery, rows, options)`. The factory returns an ordinary compiled, typed single-row
`INSERT` with an explicit column list and one ordered parameter per column. It has no `RETURNING`,
conflict clause, CTE or query source. Each row preserves the same SQL shape and physical targets.

Rows can be synchronous or asynchronous iterables. `chunkRows` bounds native vector chunks from
1 to 2048 rows; the default is 2048. The result and `onProgress` callback report `rows` and `chunks`.
Progress reports data transferred to operation-owned staging, before the target transaction commits.
The operation uses temporary staging to preserve partial or reordered columns, target defaults and
generated columns. Native vectors preserve nested values, including active UNION members containing
NULL. The appender closes before the final insertion commits.

A root append is atomic. Inside a transaction, obtain the capability from its callback scope; it
shares that transaction. Producer, validation, progress callback, cancellation or constraint failures
close the producer and appender and roll back. Await every append before its transaction callback
returns. Produce rows independently of operations on the leased connection.

## Native verification and query plans

The explicit `/node-api` entrypoint exports `createNodeDuckDBLiveVerifier(options)` and
`createNodeDuckDBPlanInspector(options)`. Both accept the same connection and ownership options as
`createNodeDuckDBDatabase`. These factories return synchronous, lazy service objects: loading a config
and reading service metadata do not import the SDK or open a database. The first native method
initializes the service once; concurrent calls share that initialization. Closing an unused service
keeps it offline. Closing an active service drains admitted work and releases owned resources.

```ts
import { defineConfig } from '@typed-sql/core';
import { duckdb } from '@typed-sql/duckdb/analysis';
import {
  createNodeDuckDBLiveVerifier,
  createNodeDuckDBPlanInspector,
} from '@typed-sql/duckdb/node-api';

export default defineConfig({
  dialect: duckdb(),
  schema: { file: 'schema.json' },
  outDir: 'generated',
  verification: { live: createNodeDuckDBLiveVerifier({ path: 'app.duckdb' }) },
  plans: { live: createNodeDuckDBPlanInspector({ path: 'app.duckdb' }) },
});
```

An existing database exposes `liveVerifier` and `planInspector` services
that share its connection lease and compatibility checks. Close a standalone service to release its
owned resources; close the database to release services obtained from that database.

Verification prepares and describes SQL without executing it. Native metadata does not report
nullability, and parameter-dependent expressions can leave column or parameter metadata unavailable;
verification reports those limits explicitly.

Plan capture uses non-executing `EXPLAIN (FORMAT JSON)`, including for DML. Parameterized captures
require transient samples and resolved native parameter targets. Nested samples use the same exact
codecs and UNION transport as execution. The normalized inventory contains node kinds, relation
names and available row estimates. Expressions, SQL, samples and native error text are excluded.
The environment records optimizer settings and hashes exposed table cardinality estimates and
catalog structure. DuckDB does not expose a comparable cost estimate through this protocol.

Start with the [quickstart](../getting-started/duckdb.md), then explore
[nested and analytical examples](../examples/duckdb.md).
