---
"@typed-sql/duckdb": patch
---

Describe guarded stored-table SELECT queries through native contracts, including projections,
stars, filters and joins. Bind context to live relation/column definitions and reject generated
columns and unsafe relation bindings before candidate preparation. Reject user macro overlaps in
implicit operator, constructor and extraction bindings as well as explicit calls. Update the acquisition identity
so earlier artifacts require regeneration.
