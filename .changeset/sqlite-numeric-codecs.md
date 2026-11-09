---
"@typed-sql/sqlite": patch
---

Carry policy-bound integer/real runtime codecs through known numeric expressions, aggregates,
casts, derived projections and compound queries. Numeric parameters retain those codecs instead
of falling back to unknown, while empty aggregate results remain nullable.
