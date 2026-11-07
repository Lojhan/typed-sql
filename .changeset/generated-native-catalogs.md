---
"@typed-sql/postgres": minor
"@typed-sql/sqlserver": minor
"@typed-sql/duckdb": minor
---

Generate grammar catalogs from reviewed engine facts and explicit grammar policy. PostgreSQL
resolves native scalar overloads, defaults and variadics using its existing decoding policy, and
uses native aggregate result types instead of assuming the input type. SQL Server type rules and
system aliases use native dimensions. DuckDB preserves unavailable macro parameter types and
applies explicit policies for specialized macro semantics.
DuckDB scalar aliases and common-type tables are generated from native descriptions. Temporal
averages preserve their native result type, and FLOAT quantile arrays preserve FLOAT elements.
