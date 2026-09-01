---
"@typed-sql/postgres": minor
---

Complete PostgreSQL DML parsing and analysis for identity overriding, `ON CONFLICT` targets and the
`excluded` namespace, row assignments, source-aware update/delete returning, versioned `MERGE`, and
PostgreSQL 18 old/new `RETURNING` aliases. Version-dependent forms now use server-major evidence and
fail closed when that evidence is absent or outside the feature's supported range.
