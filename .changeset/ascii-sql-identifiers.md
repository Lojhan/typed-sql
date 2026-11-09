---
"@typed-sql/duckdb": patch
"@typed-sql/sqlite": patch
"@typed-sql/core": minor
---

Use grammar-owned ASCII case rules in DuckDB and SQLite. Unicode spellings that JavaScript folds into ASCII no longer resolve optimistically to builtins, SQL keywords or type aliases. Allow schema indexes to receive a comparison policy and cache indexes separately by policy.
