---
"@typed-sql/core": minor
"@typed-sql/compiler": minor
"@typed-sql/analysis": patch
"@typed-sql/postgres": patch
---

Expose grammar-neutral profiles and collect finite source/SQL-file query candidates before semantic analysis. Share rendering and binding normalization with compilation, preserve nested placeholder indexes and source spans after fragment expansion, and reject explicit structural expressions that remain unrendered instead of treating them as parameters.
