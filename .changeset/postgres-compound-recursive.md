---
"@typed-sql/postgres": minor
---

Infer PostgreSQL `UNION`, `INTERSECT`, and `EXCEPT` rows and recursive CTE seed/member contracts,
including PostgreSQL 14+ `SEARCH` and `CYCLE` generated columns. Invalid compound arity, missing
`WITH RECURSIVE`, misplaced seed terms, unsafe self-reference shapes, and invalid generated-column
references now fail closed with stable diagnostics and source spans.
