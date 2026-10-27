---
"@typed-sql/postgres": patch
"@typed-sql/ts-bridge": patch
---

Keep complete row and parameter types in TypeScript 7.1 preview inspections without display truncation. Reject native pg cursor streaming and COPY on pipeline-enabled connections before submitting a custom query, and use separate pools for streaming and pipeline queries.
