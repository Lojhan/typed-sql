---
"@typed-sql/core": patch
---

Reuse immutable SQL text segments and whole interpolation-free fragments at template callsites, and avoid spread allocations while composing predicates, joins, and appended queries.
