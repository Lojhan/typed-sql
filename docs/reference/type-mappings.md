---
title: Database type mappings
description: PostgreSQL, MySQL, and SQLite mappings from catalog types through inferred TypeScript types to runtime driver values.
---

# Database type mappings

The inferred row type describes values returned by the typed-sql adapter under the selected `typePolicy`. Generation and runtime execution must use the same policy object.

## PostgreSQL

| PostgreSQL type | Default TypeScript type | Runtime value |
| --- | --- | --- |
| `smallint`, `integer` | `number` | Finite JavaScript number |
| `bigint` | `bigint` | Native `bigint` |
| `numeric`, `decimal` | `string` | Exact decimal text |
| `real`, `double precision` | `number` | JavaScript number |
| `boolean` | `boolean` | JavaScript boolean |
| text, character, `uuid` | `string` | JavaScript string |
| `date`, `timestamp`, `timestamptz` | `Date` | JavaScript `Date` |
| `json`, `jsonb` | `unknown` | Parsed JSON value |
| `bytea` | `Uint8Array` | `Uint8Array` |
| enum | Literal string union | JavaScript string |
| supported `T[]` | `readonly T[]` | Recursively decoded array |
| nullable column | `T | null` | `null` bypasses scalar codecs |

The PostgreSQL adapter installs parsers per query and does not mutate global `pg.types`.
Policy-controlled scalar and array OIDs use typed-sql codecs. Active extension manifests may add
connection-local OID decoders; other OIDs delegate to the installed driver parser table.

Policy alternatives:

| Policy field | Values | Guarantee |
| --- | --- | --- |
| `bigint` | `bigint`, `string`, `number` | `number` rejects values outside the safe integer range. |
| `numeric` | `string`, `number`, `Decimal` | `number` rejects non-finite values; `Decimal` requires a converter. |
| `date` | `Date`, `string` | `string` preserves driver text and database precision. |
| `json` | `unknown`, `JsonValue`, `string` | Object modes parse JSON; `string` preserves text. |
| `enums` | `string-union`, `string` | Both decode strings; only inference changes. |

`timestamp without time zone` follows the Node.js process timezone when represented as `Date`. JavaScript dates lose PostgreSQL sub-millisecond precision. Choose `string` when those semantics are not acceptable.

## MySQL

| MySQL type | Default TypeScript type | Runtime value |
| --- | --- | --- |
| `tinyint(1)`, `boolean`, `bool` | `boolean` | Strict `0` or `1` conversion |
| other integer types | `number` | JavaScript number |
| `bigint` | `bigint` | Native `bigint` |
| `decimal`, `numeric` | `string` | Exact decimal text |
| `float`, `double`, `real` | `number` | JavaScript number |
| `bit` | `Uint8Array` | Node.js `Buffer` |
| character, text, `time`, `set` | `string` | JavaScript string |
| binary and blob types | `Uint8Array` | Node.js `Buffer` |
| spatial types | `Uint8Array` | Opaque MySQL geometry bytes in a Node.js `Buffer` |
| `date`, `datetime`, `timestamp` | `Date` | Date converted from lossless text |
| `year` | `number` | JavaScript number |
| `json` | `unknown` | Parsed JSON value |
| `vector` on MySQL 9.7 or later | `Uint8Array` | Node.js `Buffer` |
| enum | Literal string union | JavaScript string |
| nullable column | `T | null` | `null` bypasses scalar codecs |

The adapter owns mysql2 settings that affect row shape and decoding. Supplying conflicting options through `poolConfig` fails before a pool is created.

Expression inference also uses the selected server catalog. Exact integer arithmetic uses the
`bigint` policy when MySQL produces a 64-bit result; decimal arithmetic uses the `decimal` policy;
and any approximate operand produces `number`. Unsigned arithmetic remains unsigned except for
subtraction under `NO_UNSIGNED_SUBTRACTION`. String results carry charset, collation, and
coercibility evidence internally so comparisons, `CONCAT`, character-set introducers, and explicit
`COLLATE` clauses can reject incompatible combinations.

Policy alternatives:

| Policy field | Values | Guarantee |
| --- | --- | --- |
| `bigint` | `bigint`, `string`, `number` | `number` rejects values outside the safe integer range. |
| `decimal` | `string`, `number`, `Decimal` | `number` may approximate fractions; `Decimal` requires a converter. |
| `date` | `Date`, `string` | Conversion occurs after mysql2 returns text. |
| `json` | `unknown`, `JsonValue`, `string` | Object modes use parsed JSON; `string` serializes it. |
| `tinyint1` | `boolean`, `number` | Conversion follows field type and length metadata. |

The adapter requests date, datetime, and timestamp values from mysql2 as text before applying the
selected policy. `string` preserves fractional precision, zero components, and the server text.
`Date` uses JavaScript date parsing, loses precision below milliseconds, and represents a MySQL
zero-date value as an invalid `Date`; applications that permit zero dates or require lossless
temporal values should select `string`. Snapshot compatibility checks the session and system time
zones before dispatch when `compatibilitySnapshot` is enabled.

## SQLite

SQLite mappings depend on whether the table is STRICT. Ordinary tables use a declared affinity but
can store values from another storage class, so a narrower declared-type mapping would be unsound.

| SQLite catalog evidence | Default TypeScript type | `node:sqlite` runtime value |
| --- | --- | --- |
| non-STRICT column | `bigint \| number \| string \| Uint8Array` | Native SQLite storage-class value |
| rowid or exact `INTEGER PRIMARY KEY` alias | `bigint` | Native `bigint` through `setReadBigInts(true)` |
| STRICT `INT`, `INTEGER` | `bigint` | Native `bigint` through `setReadBigInts(true)` |
| STRICT `REAL` | `number` | JavaScript number |
| STRICT `TEXT` | `string` | JavaScript string |
| STRICT `BLOB` | `Uint8Array` | Node.js `Buffer` |
| STRICT `ANY` | Flexible storage union | Native SQLite storage-class value |
| nullable column | `T \| null` | `null` |

SQLite JSON functions return `string` for JSON text and `Uint8Array` for JSONB. A single-path
`json_extract`/`jsonb_extract` can instead produce any SQLite storage class, so it uses the flexible
storage union; multiple paths return JSON text or JSONB respectively. `json_each` and `json_tree`
use the same flexible union for `value` and `atom`.

SQLite date/time text functions return `string | null`, `julianday` returns `number | null`, and
`unixepoch` returns the configured integer type unless a literal `subsec`/`subsecond` modifier makes
the result `number | null`. Optional math and percentile functions return `number | null` after
their compile-option evidence has been established.

The `integer` policy can select `number`; use it only when the application accepts JavaScript's
safe-integer limit. The `flexible` policy can select `unknown` instead of the storage union. The
same policy must be passed to the dialect, provider, and adapter.

SQLite's historical primary-key nullability exception is preserved: an ordinary non-STRICT rowid
table can report nullable non-rowid primary-key columns. Exact rowid aliases, STRICT primary keys,
and `WITHOUT ROWID` primary keys remain non-null.

## Nullability, aggregates, and drift

Nullability is applied after scalar mapping. Outer joins add `null` to columns from the nullable relation. `COUNT` follows the dialect's bigint policy, while decimal-producing aggregates follow the numeric or decimal policy.

Generated snapshots include a `typePolicyHash`. `typed-sql drift` detects policy changes even when the database catalog remains unchanged.
