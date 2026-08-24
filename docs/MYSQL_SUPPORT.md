# MySQL support

The MySQL grammar targets MySQL 8.4 LTS and uses `?` parameters, backtick identifiers, MySQL string
rules, and `LIMIT offset,count`. The real-database suite is pinned to official MySQL 8.4.11.

Supported inference includes SELECT aliases/stars, inner/outer/cross joins, CTEs, derived and
correlated subqueries, GROUP BY/HAVING/windows, CASE, scalar/EXISTS/IN/BETWEEN expressions, common
aggregates and JSON functions/operators, INSERT/UPDATE/DELETE command typing, enums, unsigned
integers, decimals, JSON, dates, binary values, and `tinyint(1)` policy mapping.

Recursive CTE inference, FULL JOIN, ARRAY constructors, aggregate FILTER, and MySQL-incompatible
RETURNING clauses produce `TSQ401`. INSERT/UPDATE/DELETE without a result surface infer
`Query<never>`. Unknown functions warn and infer `unknown`; ambiguous or structurally unsafe queries
are errors.

The grammar import does not require `mysql2`. Applications that choose mysql2 install it and import
`@typed-sql/mysql/mysql2`. The adapter enables lossless bigint/decimal defaults, explicit alternative
codecs, nested savepoints, and catalog introspection without mutating driver globals.
