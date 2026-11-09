---
"@typed-sql/duckdb": patch
---

Report an unsupported result when nullable DuckDB 1.5 table-function arguments can change the native output type. NULL and non-NULL parameter bindings can produce different schemas even when the SQL casts are identical.
