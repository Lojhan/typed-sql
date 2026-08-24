# PostgreSQL support matrix

This document describes the 1.0 static inference boundary. A feature not marked supported must
produce a parse/resolution diagnostic or remain `Query<unknown>`; it must not receive an optimistic
row type.

| Surface | 1.0 status | Notes |
| --- | --- | --- |
| Static tagged templates | Supported | `sql` bindings imported from `@typed-sql/postgres` are recognized, including aliases. |
| `SELECT`, `DISTINCT`, `DISTINCT ON` | Supported | Static row-shape inference. |
| Tables and schema-qualified tables | Supported | Catalog snapshot resolution and ambiguity diagnostics. |
| Aliases | Supported | Quoted/unquoted table and output aliases. |
| `INNER`, `LEFT`, `RIGHT`, `FULL [OUTER] JOIN ... ON` | Supported | Outer-join nullability propagates into result columns. |
| `WHERE`, `GROUP BY`, `HAVING` | Parsed/resolved | No query-plan or cardinality inference. |
| `ORDER BY`, `LIMIT`, `OFFSET` | Parsed | Does not change row shape. |
| Columns, literals, `$n` parameters, unary/binary expressions | Supported | Parameters remain `unknown` until parameter typing lands. |
| `CAST(x AS type)` and `x::type` | Supported | Known built-ins, snapshot enums, and domains are validated. |
| `CASE` | Supported | Branch types and nullability are combined. |
| `COUNT`, `COALESCE`, `MIN`, `MAX`, `SUM` | Supported | Other catalog functions resolve by name/arity; unknown calls warn. |
| `*` / `relation.*` expansion | Supported | `USING` columns are merged; duplicate output properties diagnose. |
| CTEs and derived/correlated/scalar subqueries | Supported | Recursive CTEs and unsafe scalar/IN arity diagnose. |
| Set operations | Not supported | Fail during parsing; no optimistic result type. |
| `INSERT`, `UPDATE`, `DELETE`, `RETURNING` | Supported | Commands without `RETURNING` infer `Query<never>`. |
| Window functions and aggregate `FILTER` | Supported | Named and inline window specifications resolve expressions. |
| `WITHIN GROUP` | Not supported | Fails safely during parsing. |
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
