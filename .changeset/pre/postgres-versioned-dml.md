---
"@typed-sql/core": minor
"@typed-sql/postgres": minor
---

Complete PostgreSQL DML parsing and analysis for identity overriding, `ON CONFLICT` targets and the
`excluded` namespace, row assignments, source-aware update/delete returning, versioned `MERGE`, and
PostgreSQL 18 old/new `RETURNING` aliases. Version-dependent forms now use server-major evidence and
fail closed when that evidence is absent or outside the feature's supported range. Snapshot v2 index
evidence now verifies expression, operator-class, collation, and partial-predicate conflict targets,
while insert/select, update, and merge writes propagate parameter types and reject known-incompatible
source types.

The neutral resolver snapshot bridge now exposes optional index and constraint-deferrability evidence
so grammar packages can consume schema v2 conflict-target metadata without importing schema internals.
