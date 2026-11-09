---
"@typed-sql/postgres": minor
---

Add lightweight profile and tag entrypoints for query-contract consumers, plus explicit native
acquisition through an application-owned pg pool. The PostgreSQL 18 adapter qualifies expression
queries through Parse/Describe without executing application statements. It records native types,
modifiers and parameter identities, preserves unknown nullability/representations, and rejects
unsupported contexts or writes during the guarded acquisition interval.
