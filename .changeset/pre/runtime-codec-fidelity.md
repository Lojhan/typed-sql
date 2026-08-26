---
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
---

Prove and document runtime codec fidelity against live PostgreSQL and MySQL values. PostgreSQL now
delegates non-policy OIDs to the installed pg parser table, MySQL maps BIT to Uint8Array, and the
mysql2 adapter rejects pool settings that would contradict its type policy.
