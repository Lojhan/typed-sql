---
"@typed-sql/analysis": minor
"@typed-sql/postgres": minor
---

Add bounded, context-bound project catalog data with explicit grammar interpreters and inference
permissions. PostgreSQL selects complete routine families from introspected metadata using SQL
calls and permits offline reuse of qualified fixed scalar results. Preserve parameter/default
metadata, recompute types from the configured policy, keep results nullable, and require exact
query evidence for unsupported declaration forms. Catalog selection changes analysis identity;
conflicting owners, changed contexts and unsupported permissions fail closed.

Record qualified native PostgreSQL argument/result type identities during introspection. Strict
null-input behavior no longer incorrectly marks an introspected routine's result as non-null.
