---
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
"@typed-sql/sqlserver": minor
"@typed-sql/duckdb": minor
---

Expose explicit driver-free `/profile` entrypoints for contract consumers without loading semantic
catalogs, resolvers or introspection providers. Existing analyzer factories share the same profile
mechanics, including parameter extraction, snapshot validation, rendering and type policy. DuckDB
retains contextual parser-based parameter extraction.
