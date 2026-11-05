---
title: SQL Server
pageType: reference
description: SQL Server grammar, compatibility levels, catalog snapshots, exact type policies, and application-owned ODBC execution.
---

# SQL Server

`@typed-sql/sqlserver` owns T-SQL parsing, inference, native type policies and catalog snapshots.
Applications import `sql` from this package. The explicit `@typed-sql/sqlserver/odbc` entrypoint
loads the application's `msnodesqlv8` installation and Microsoft ODBC Driver 18.

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
| `@typed-sql/sqlserver/odbc` | `msnodesqlv8` | >=6.2.2, <7 | 6.2.2, ODBC 18.7.1.1, unixODBC 2.3.12, Linux x64 |
| `@typed-sql/sqlserver/runtime` | Your connection implementation | Explicit qualified connection protocol | Protocol tests |

Install drivers explicitly:

```sh
pnpm add @typed-sql/sqlserver msnodesqlv8
```

Microsoft ODBC Driver 18 and the native driver's platform prerequisites are separate system
installations. Native Linux x64 engine results do not qualify an emulated SQL Server container.

## Exact values

The default policy maps `bigint` to `bigint`, decimal and money values to decimal strings,
temporal values to strings, binary values to `Uint8Array`, and JSON storage to strings.
Ordinary integer and floating types map to `number`; `bit` maps to `boolean`. CLR, spatial,
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

## Execution and physical preparation

```ts
import { createSqlServerOdbcDatabase } from "@typed-sql/sqlserver/odbc";

const database = await createSqlServerOdbcDatabase({
  connectionString: () => process.env.SQLSERVER_CONNECTION_STRING!,
});
```

The factory reads the actual engine, product, database compatibility level and session settings.
Owned sessions establish `QUOTED_IDENTIFIER`, `ANSI_WARNINGS`, `ARITHABORT` and
`CONCAT_NULL_YIELDS_NULL` as enabled, with `us_english`, `DATEFORMAT mdy` and `DATEFIRST 7`.
Injected connections are validated without changing SQL session semantics unless
`configureSession: true` is explicit. Closing a wrapper frees its prepared handles; an injected
connection remains application-owned unless `ownsConnection: true` is explicit.

`database.prepare(name, factory)` caches logical rendering and value plans. The ODBC adapter
uses physical native preparation only when its result transport is qualified. The pinned native
driver removes a genuine trailing NUL from prepared text results. Statements returning arbitrary
text, XML or JSON therefore use the exact raw path **before execution**. This choice preserves
`OUTPUT`, ordering and side effects: the adapter neither rewrites projections nor retries an
already executed statement. Numeric, temporal and binary results can use native preparation.
An application-provided neutral adapter can declare its own `supportsPreparedPlan` capability.

`maximumPreparedValueBytes` bounds the encoded parameter transport for logical prepared queries;
it defaults to 1 MiB. Oversized inputs fail before dispatch. Native prepared result buffer failures
propagate as errors, and handles are cleaned up before a connection is reused.

Transactions provide buffered queries, prepared factories, atomic batches and explicitly closeable
streams through the callback scope. Scope batches reuse the existing transaction. Root batches
are atomic. Returning while work or a stream remains active drains or closes it, reports misuse
and rolls back. Nested transactions are explicitly unsupported. See [Execution](../guides/execution.md).

## Catalogs and SQL

`SqlServerSchemaProvider` accepts an application-owned queryable; `sqlServerOdbc()` is the lazy
native provider. Introspection requires database `VIEW DEFINITION` and writes schema format 2,
including column order, aliases, identity/computed/default evidence, collations and code pages,
write eligibility, temporal/history attributes, constraint trust, filtered/included indexes and
routine signatures. Raw expressions are retained as fingerprints rather than published definitions.
Generated schema files are compiler inputs, not runtime application imports.

The grammar covers joins and `APPLY`, ordinary and recursive CTEs, scalar subqueries, set operations,
window frames, `TOP`, `OFFSET/FETCH`, `INSERT`, `UPDATE`, `DELETE` and `OUTPUT`.
Native JSON constructor inference follows the selected JSON policy. `FOR JSON` returns text chunk
rows, because one document can span multiple server rows. Unsupported syntax, ambiguous names,
invalid expression contexts and unqualified capabilities produce diagnostics.

See [Type mappings](../reference/type-mappings.md) and [SQL files](../guides/sql-files.md).
