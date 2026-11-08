---
"@typed-sql/analysis": minor
"@typed-sql/postgres": minor
---

Add explicit native project-catalog acquisition with automatic context observation, guarded
before/after validation, cancellation and owned cleanup. PostgreSQL captures matching routine
families on one leased connection using metadata-only queries and the shared introspection
mapper. Reject truncated families, unsupported selections and mismatched server evidence.
Metadata collection does not prepare or execute the selected application statements.
