---
title: MySQL
description: MySQL grammar coverage, catalog introspection, application-owned mysql2 integration, and deliberate limitations.
---

# MySQL

`@typed-sql/mysql` contains the MySQL grammar, catalog model, resolver, type policy, and runtime codecs. The optional `@typed-sql/mysql/mysql2` entrypoint loads the `mysql2` driver installed by your application.

## Public entrypoints

- `@typed-sql/mysql` — `sql`, dialect factory, default type policy, analysis, and type mapping.
- `@typed-sql/mysql/runtime` — driver-neutral rendering and codec utilities.
- `@typed-sql/mysql/mysql2` — schema provider and executable database adapter for application-owned `mysql2`.

## Supported SQL

The grammar targets MySQL 8.4 LTS and supports:

- aliases, stars, and inner, outer, or cross joins;
- CTEs and derived or correlated subqueries;
- grouping, aggregates, windows, and `CASE`;
- scalar, `EXISTS`, `IN`, and `BETWEEN` expressions;
- common JSON functions and operators;
- `INSERT`, `UPDATE`, and `DELETE` command typing;
- ordered parameters inferred from comparisons, DML targets, casts, ranges, limits, and cataloged function arguments.

Catalog inference covers enums, unsigned integers, decimals, JSON, temporal types, binary values, and configurable `tinyint(1)` mapping.

Recursive CTE inference, `FULL JOIN`, array constructors, aggregate `FILTER`, and incompatible `RETURNING` clauses produce `TSQ401`. Commands without a result surface infer `Query<never, Parameters>`. Unknown functions warn and infer `unknown`; ambiguous or structurally unsafe queries are errors.

## Runtime behavior

The adapter controls mysql2 options that affect row shape and decoding. Supplying conflicting `poolConfig` options such as `typeCast`, `rowsAsArray`, or incompatible bigint, decimal, date, or JSON settings fails before a pool is created. Connection, TLS, timeout, and pool-capacity settings remain application-owned.

See [Database type mappings](../reference/type-mappings.md#mysql) and [Compatibility](../reference/compatibility.md).
