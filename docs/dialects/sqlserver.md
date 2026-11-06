---
title: SQL Server
pageType: reference
description: SQL Server grammar, compatibility levels, catalog snapshots, exact type policies, and application-owned ODBC execution.
---

# SQL Server

`@typed-sql/sqlserver` is a stable grammar package. It owns T-SQL parsing, inference, native type policies and catalog snapshots.
Applications import `sql` from this package. The explicit `@typed-sql/sqlserver/odbc` entrypoint
loads the application's Koffi installation and uses Microsoft ODBC Driver 18 through unixODBC.
Native execution is qualified on Linux x64; grammar analysis and the browser entrypoint remain portable.

## Public entrypoints

| Import | Purpose |
| --- | --- |
| `@typed-sql/sqlserver/query` | Portable `sql`, renderer, compiler value plans and query types. |
| `@typed-sql/sqlserver` | Grammar factory, policies, analysis and injected catalog provider. |
| `@typed-sql/sqlserver/runtime` | Driver-neutral execution, live verification, plan inspection and connection ownership. |
| `@typed-sql/sqlserver/odbc` | Exact application-owned direct ODBC execution and introspection. |
| `@typed-sql/sqlserver/msnodesqlv8` | Explicit compatibility adapter with restricted text transport. |
| `@typed-sql/sqlserver/browser` | Grammar surface without native adapters or catalog provider exports. |

## Compatibility

Engine versions and database compatibility levels are separate settings.

| Boxed SQL Server engine | Supported compatibility levels | Exact engine build tested |
| --- | --- | --- |
| 2017, major 14 | 140 | 14.0.3560.2 |
| 2019, major 15 | 140, 150 | 15.0.4500.2 |
| 2022, major 16 | 140, 150, 160 | 16.0.4305.5 |
| 2025, major 17 | 140, 150, 160, 170 | 17.0.5035.5 |

The grammar supports these engine families; the last column identifies the particular builds
used for native verification. Unknown future versions, prereleases, missing settings and
unmodeled products produce conservative analysis. Azure SQL products have distinct capabilities
and do not satisfy the boxed SQL Server contract.

| Execution adapter | Application dependency | Accepted driver range | Exact native transport tested |
| --- | --- | --- | --- |
| `@typed-sql/sqlserver/odbc` | `koffi` | 3.3.7 | Koffi 3.3.7, ODBC 18.7.1.1, unixODBC 2.3.12, Node 24.22.2, Linux x64 |
| `@typed-sql/sqlserver/msnodesqlv8` | `msnodesqlv8` | >=6.2.2, <7 | 6.2.2 on Linux x64; unsupported text families reject |
| `@typed-sql/sqlserver/runtime` | Your connection implementation | Explicit qualified connection protocol | Protocol tests |

Install drivers explicitly:

```sh
pnpm add @typed-sql/sqlserver koffi
```

Microsoft ODBC Driver 18 and the native driver's platform prerequisites are separate system
installations. Before issuing SQL, the direct adapter reads and validates the actual native driver
identity: Microsoft ODBC Driver 18 is accepted, with 18.7.1.1 tested. An ODBC connection string
that selects a different driver does not satisfy this contract. Native Linux x64 engine results do not qualify an emulated SQL Server container.

## Exact values

The default policy maps `bigint` to `bigint`, decimal and money values to decimal strings,
temporal values to strings, binary values to `Uint8Array`, and JSON storage to strings.
Ordinary integer and floating types map to `number`; `bit` maps to `boolean`. Typed number plans
require finite values and reject integer-valued numbers outside JavaScript's safe integer range,
including very large floating values. CLR, spatial,
`sql_variant` and otherwise unproven types remain `unknown`.

Decimal validation preserves precision and scale without passing through `number`.
`datetime2`, `time` and `datetimeoffset` strings retain up to seven fractional digits.
`datetimeoffset` results represent the same instant in UTC; the original offset is not retained.
The explicit `Date` temporal policy has JavaScript's millisecond precision. An explicit `Decimal`
policy requires application encode/decode functions. Inference and runtime decoding use the same
policy hash.

Binary parameters use canonical hexadecimal text with a typed style-2 conversion. Empty bytes
therefore remain empty binary, and `null` remains SQL `NULL`. Binary results are copied into
independently owned byte arrays. Text parameters enforce native lengths, including UTF-8 byte
limits and Windows-1252 representability when those collations are known. Unproven VARCHAR
collations accept ASCII parameters conservatively.
Rowversion results remain `Uint8Array`. Comparison parameters use `binary(8)`, so they can be bound
without assigning a generated rowversion value. Oversized inputs reject before SQL; shorter fixed
binary inputs retain SQL Server's padding semantics. Rowversion columns cannot be assigned in
`INSERT`, `UPDATE` or `OUTPUT INTO`.

## Execution and physical preparation

```ts
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

const database = await createSqlServerOdbcDatabase({
  connectionString: () => process.env.SQLSERVER_CONNECTION_STRING!,
});
```

The factory reads the actual engine, product, database compatibility level and session settings.
Before each typed dispatch, the native adapter rereads these facts while holding the same execution
lease. Changed database, compatibility level, collation, default schema or critical session settings
reject the request before its SQL executes. Recreate the wrapper after intentional changes. The
raw catalog/setup queryable bypasses this typed check so session repair and metadata tools can
operate without recursive lease acquisition. Application-supplied neutral connections can provide
`readServerEvidence(controls)` for the same checks, or attest their own session through `serverEvidence`.
Cancellation and deadlines cover the native evidence reads as well as application execution.
Pre-aborted and expired requests issue neither private evidence SQL nor application SQL.
Owned sessions establish `QUOTED_IDENTIFIER`, `ANSI_WARNINGS`, `ARITHABORT` and
`CONCAT_NULL_YIELDS_NULL` as enabled, with `us_english`, `DATEFORMAT mdy` and `DATEFIRST 7`.
Use `configureSession: false` to validate the existing session instead of changing it. The direct factory
owns its connection and worker lanes; closing the database frees its prepared handles and closes
the native session. For an injected protocol connection, use `createSqlServerDatabase` from
`/runtime` and choose `ownsConnection` explicitly.

`database.prepare(name, factory)` caches logical rendering, value plans and physical prepared
handles. Unicode inputs keep an `NVARCHAR(MAX)` binding independent of value length; grammar-owned
typed conversions select each actual SQL target. Empty values, SQL `NULL`, embedded NULs and
trailing NULs remain distinct. Result collection uses explicit ODBC byte counts, including across
large text and surrogate boundaries. REAL and FLOAT results use binary C floating types rather
than decimal display text.

Typed buffered and streamed statements validate prepared result metadata before execution when
the driver makes it available. Width, names, native families, precision and scale are checked;
result decoding and validators still run on the actual values. SQL Server's native JSON type can
appear as an unlimited VARCHAR text wire in ODBC. The adapter retains that physical description,
accepts it only for qualified logical JSON plans, and validates the JSON text before returning it.
It does not rename a VARCHAR result to pretend it proves a native JSON type.

Cancellation and deadlines cover metadata reads, preparation and execution. A separate control
worker requests cancellation, and the execution lease remains held until native calls and cleanup
settle. Cancellation does not retry an executed statement. Failed or uncertain cleanup quarantines
the connection. Explicitly close streams so native cursors and their leases can be released.

`maximumPreparedValueBytes` bounds logical prepared inputs and defaults to 1 MiB. Direct transport
also has configurable limits: `maximumCellBytes` defaults to 16 MiB, `maximumResultBytes` to 64 MiB,
`maximumRows` to 100,000 and `chunkBytes` to 4,096. The byte limit applies to a buffered result or
one stream fetch batch; the row limit applies across the statement. Limits count payload bytes;
native buffers, JavaScript values and worker message copies add bounded overhead. `connectionTimeoutSeconds`
defaults to 15 and `queryTimeoutSeconds` to 30. Rejecting an oversized result does not retry SQL.

### msnodesqlv8 compatibility

Import this adapter explicitly when its supported transport matches your application:

```ts
import { createSqlServerMsnodesqlv8Database } from "@typed-sql/sqlserver/msnodesqlv8";
```

Its SDK removes genuine trailing NULs from prepared text, so arbitrary text, XML and JSON results
select a qualified raw path before dispatch. Raw large VARCHAR and legacy TEXT collection can
also corrupt values. Compiled results returning `varchar(max)`, `text` or unqualified `ntext`
reject before dispatch, including DML `OUTPUT`. Raw queryable requests reject those metadata
families before exposing rows, after any SQL side effects have already occurred. Bounded VARCHAR
and separately qualified raw NVARCHAR(MAX) paths remain available. Controlled logical prepared
queries use raw execution because the SDK's preparation RPC does not expose cancellation here.

Transactions provide buffered queries, prepared factories, atomic batches and explicitly closeable
streams through the callback scope. Scope batches reuse the existing transaction. Root batches
are atomic. Returning while work or a stream remains active drains or closes it, reports misuse
and rolls back. Nested transactions are explicitly unsupported. See [Execution](../guides/execution.md).

## Catalogs and SQL

`SqlServerSchemaProvider` accepts an application-owned queryable; `sqlServerOdbc()` is the lazy
native provider. Introspection requires database `VIEW DEFINITION` and writes schema format 2,
including column order, aliases, identity/computed/default evidence, collations and code pages,
write eligibility, temporal/history attributes, constraint trust, filtered/included indexes and
routine signatures. Active history tables and generated period columns are not writable. Alias
nullability remains separate from each column's actual nullability; standalone and alias-bound
defaults retain presence even when their definitions are unavailable. Raw expressions are retained
as fingerprints rather than published definitions. Object-level permission restrictions can hide
metadata despite a database-level grant; capture with a principal that can see every intended
object. Introspection does not grant permissions.
Generated schema files are compiler inputs, not runtime application imports.

The grammar covers joins and `APPLY`, ordinary and recursive CTEs, scalar subqueries, set operations,
window frames, `TOP`, `OFFSET/FETCH`, `INSERT`, `UPDATE`, `DELETE` and `OUTPUT`.
Native JSON constructor inference follows the selected JSON policy. `FOR JSON` returns text chunk
rows, because one document can span multiple server rows. Unsupported syntax, ambiguous names,
invalid expression contexts and unqualified capabilities produce diagnostics.

See [Type mappings](../reference/type-mappings.md) and [SQL files](../guides/sql-files.md).

## Native verification and plans

`createSqlServerLiveVerifier` and `createSqlServerPlanInspector` from
`@typed-sql/sqlserver/runtime` accept an application-owned pool. Each `acquire()` must return
one exclusive physical session with `all(sql, values)`, `release()` and `discard()` methods.
Parameter and result descriptions use native SQL Server metadata without executing application
DML. Physical type comparison includes lengths, precision and scale. SHOWPLAN capture accepts
read queries, restores the session setting before release, and discards sessions after cleanup failure.
