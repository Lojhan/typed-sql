---
"@typed-sql/compiler": patch
---

Skip optimizer-plan capture for runtime-sized mapped fragment-list queries with an explicit
`repeated-fragment-cardinality` reason. Their compiler SQL represents a list shape for analysis,
not a measured runtime cardinality, so its plan must not satisfy budgets for arbitrary list sizes.
Plan review reports these queries as unavailable and honors uncertainty failure policy.
