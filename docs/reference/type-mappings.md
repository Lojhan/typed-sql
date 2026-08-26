---
title: Database type mappings
description: PostgreSQL and MySQL mappings from catalog types through inferred TypeScript types to runtime driver values.
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
| `bytea` | `Uint8Array` | Node.js `Buffer` |
| enum | Literal string union | JavaScript string |
| supported `T[]` | `readonly T[]` | Recursively decoded array |
| nullable column | `T | null` | `null` bypasses scalar codecs |

The PostgreSQL adapter installs parsers per query and does not mutate global `pg.types`. Policy-controlled OIDs use typed-sql codecs; other OIDs delegate to the installed driver parser table.

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
| `date`, `datetime`, `timestamp` | `Date` | Date converted from lossless text |
| `year` | `number` | JavaScript number |
| `json` | `unknown` | Parsed JSON value |
| enum | Literal string union | JavaScript string |
| nullable column | `T | null` | `null` bypasses scalar codecs |

The adapter owns mysql2 settings that affect row shape and decoding. Supplying conflicting options through `poolConfig` fails before a pool is created.

Policy alternatives:

| Policy field | Values | Guarantee |
| --- | --- | --- |
| `bigint` | `bigint`, `string`, `number` | `number` rejects values outside the safe integer range. |
| `decimal` | `string`, `number`, `Decimal` | `number` may approximate fractions; `Decimal` requires a converter. |
| `date` | `Date`, `string` | Conversion occurs after mysql2 returns text. |
| `json` | `unknown`, `JsonValue`, `string` | Object modes use parsed JSON; `string` serializes it. |
| `tinyint1` | `boolean`, `number` | Conversion follows field type and length metadata. |

## Nullability, aggregates, and drift

Nullability is applied after scalar mapping. Outer joins add `null` to columns from the nullable relation. `COUNT` follows the dialect's bigint policy, while decimal-producing aggregates follow the numeric or decimal policy.

Generated snapshots include a `typePolicyHash`. `typed-sql drift` detects policy changes even when the database catalog remains unchanged.
