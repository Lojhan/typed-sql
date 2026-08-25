# Runtime codec fidelity

typed-sql's result types describe the values returned by its application-owned `pg` and `mysql2`
adapters. The schema policy used for generation and the runtime `typePolicy` passed to the adapter
must be the same object. The defaults prioritize lossless values.

This contract is tested as one chain: live catalog type → generated snapshot type → inferred query
row and parameter tuple → rendered parameter → driver field metadata → decoded JavaScript value.
The container suites use PostgreSQL 18.4 with `pg` 8.23.0 and MySQL 8.4.11 with `mysql2` 3.24.1.

## PostgreSQL and `pg`

| PostgreSQL catalog type | Default TypeScript type | Runtime representation |
| --- | --- | --- |
| `smallint`, `integer` | `number` | finite JavaScript number from `pg`'s native parser |
| `bigint` | `bigint` | native `bigint`; values outside the safe-number range are tested |
| `numeric`, `decimal` | `string` | exact decimal text, including aggregate results |
| `real`, `double precision` | `number` | JavaScript number from `pg`'s native parser |
| `boolean` | `boolean` | JavaScript boolean from `pg`'s native parser |
| text, character and `uuid` types | `string` | JavaScript string |
| `date`, `timestamp`, `timestamptz` | `Date` | JavaScript `Date` |
| `json`, `jsonb` | `unknown` | value produced by `JSON.parse` |
| `bytea` | `Uint8Array` | Node.js `Buffer`, which is a `Uint8Array` subclass |
| enum | literal string union | JavaScript string |
| supported `T[]` | `readonly (MappedT)[]` | recursively decoded array with nullable elements preserved |
| nullable column | `T \| null` | `null` is never passed through a scalar codec |

The adapter installs parsers per query and does not mutate `pg.types`. Policy-controlled OIDs are
decoded by typed-sql; every other OID delegates to the installed `pg` parser table. Application
`poolConfig.types` is excluded at the type level and rejected at runtime because it could make the
runtime disagree with the generated policy. Binary-result mode is not currently exposed by the
typed-sql query renderer.

Policy alternatives:

| Policy field | Supported values | Runtime guarantee |
| --- | --- | --- |
| `bigint` | `bigint`, `string`, `number` | `number` throws outside `Number.isSafeInteger` |
| `numeric` | `string`, `number`, `Decimal` | `number` rejects non-finite results; `Decimal` requires `decimal(value)` |
| `date` | `Date`, `string` | `Date` follows JavaScript millisecond precision; `string` preserves driver text |
| `json` | `unknown`, `JsonValue`, `string` | object modes parse JSON; `string` preserves JSON text |
| `enums` | `string-union`, `string` | both decode as strings; only the inferred type changes |

`timestamp without time zone` follows the Node process timezone when represented as `Date`, just
as `pg` does. JavaScript dates lose PostgreSQL sub-millisecond precision. Choose the `string` policy
when those semantics are not acceptable.

## MySQL and `mysql2`

| MySQL catalog type | Default TypeScript type | Runtime representation |
| --- | --- | --- |
| `tinyint(1)`, `boolean`, `bool` | `boolean` | strict `0`/`1` conversion |
| other `tinyint`, `smallint`, `mediumint`, `int` | `number` | JavaScript number |
| `bigint` | `bigint` | native `bigint`; values outside the safe-number range are tested |
| `decimal`, `numeric` | `string` | exact decimal text, including `SUM`/`AVG` results |
| `float`, `double`, `real` | `number` | JavaScript number |
| `bit` | `Uint8Array` | Node.js `Buffer`; it is deliberately not inferred as `number` |
| character, text, `time` and `set` types | `string` | JavaScript string |
| binary and blob types | `Uint8Array` | Node.js `Buffer` |
| `date`, `datetime`, `timestamp` | `Date` | typed-sql converts lossless driver text to `Date` |
| `year` | `number` | JavaScript number |
| `json` | `unknown` | parsed JSON value |
| enum | literal string union | JavaScript string |
| nullable column | `T \| null` | `null` is never passed through a scalar codec |

The adapter owns the mysql2 settings that affect row shape and decoding:
`supportBigNumbers: true`, `bigNumberStrings: true`, `decimalNumbers: false`, `dateStrings: true`,
`jsonStrings: false`, and `rowsAsArray: false`. Supplying those keys—or `typeCast`—inside
`poolConfig` fails before a pool is created with guidance to remove the option. Connection, TLS,
timeout and pool-capacity settings remain application-owned.

Policy alternatives:

| Policy field | Supported values | Runtime guarantee |
| --- | --- | --- |
| `bigint` | `bigint`, `string`, `number` | `number` throws outside `Number.isSafeInteger` |
| `decimal` | `string`, `number`, `Decimal` | `number` may approximate decimal fractions and rejects non-finite results; `Decimal` requires `decimal(value)` |
| `date` | `Date`, `string` | conversion happens after mysql2 returns date text |
| `json` | `unknown`, `JsonValue`, `string` | object modes use parsed JSON; `string` serializes the value |
| `tinyint1` | `boolean`, `number` | conversion is driven by field type and length metadata |

## Joins, aggregates and drift

Nullability is applied after scalar mapping. A nullable column and a column from the nullable side
of an outer join both infer `T | null`, while non-null runtime values retain the codec representation
above. `COUNT` uses the dialect's `bigint` policy and decimal-producing aggregates use the numeric
or decimal policy.

Generated snapshots store a `typePolicyHash`. `typed-sql drift` compares it alongside the live
catalog hash, so a policy change invalidates generated output even when the database schema did not
change. Regenerate before compiling or executing with a different policy.

The upstream behavior this adapter contract relies on is documented by
[node-postgres type parsing](https://node-postgres.com/features/types),
[node-postgres per-query parsers](https://node-postgres.com/features/queries), and
[mysql2 type conversion](https://sidorares.github.io/node-mysql2/docs/documentation).
