# PostgreSQL support matrix

This document describes the 0.2 static inference boundary. A feature not marked supported must
produce a parse/resolution diagnostic or remain `Query<unknown>`; it must not receive an optimistic
row type.

| Surface | 0.2 status | Notes |
| --- | --- | --- |
| Static tagged templates | Supported | Imported/generated `sql` bindings are recognized. |
| `SELECT`, `DISTINCT` | Supported | One top-level `SELECT` statement. |
| Tables and schema-qualified tables | Supported | Catalog snapshot resolution and ambiguity diagnostics. |
| Aliases | Supported | Quoted/unquoted table and output aliases. |
| `INNER`, `LEFT`, `RIGHT`, `FULL [OUTER] JOIN ... ON` | Supported | Outer-join nullability propagates into result columns. |
| `WHERE`, `GROUP BY`, `HAVING` | Parsed/resolved | No query-plan or cardinality inference. |
| `ORDER BY`, `LIMIT`, `OFFSET` | Parsed | Does not change row shape. |
| Columns, literals, `$n` parameters, unary/binary expressions | Supported | Parameters remain `unknown` until parameter typing lands. |
| `CAST(x AS type)` and `x::type` | Supported | Known built-ins, snapshot enums, and domains are validated. |
| `CASE` | Supported | Branch types and nullability are combined. |
| `COUNT`, `COALESCE`, `MIN`, `MAX`, `SUM` | Supported | Other catalog functions resolve by name/arity; unknown calls warn. |
| `*` / `relation.*` expansion | Not supported | Parsed, but does not expand columns in 0.2. |
| CTEs, subqueries, set operations | Not supported | Planned for 0.3. |
| `INSERT`, `UPDATE`, `DELETE`, `RETURNING` | Not supported | Planned for 0.3. |
| Window functions, `FILTER`, `WITHIN GROUP` | Not supported | Planned after core aggregate semantics. |
| Dynamic SQL/identifiers | No static inference | Runtime IR supports safe identifiers and values. |

## Catalog types

Introspection covers tables, views, columns, defaults, server version, arrays, enums, domains, and
user functions. The default policy maps PostgreSQL types as follows:

| PostgreSQL family | Default TypeScript type |
| --- | --- |
| integer/float families | `number` |
| `bigint` | `bigint` |
| `numeric`/`decimal` | `string` |
| text/character/UUID | `string` |
| boolean | `boolean` |
| date/timestamp | `Date` |
| JSON/JSONB | `unknown` |
| `bytea` | `Uint8Array` |
| enum | string-literal union |
| array | `readonly (Element)[]` |

The runtime installs per-query result parsers without mutating `pg` globals. `bigint: "number"`
rejects unsafe integers; `numeric: "Decimal"` requires an explicit decimal factory. Static policy
and runtime codec policy must match.
