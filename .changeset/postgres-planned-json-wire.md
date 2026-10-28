---
"@typed-sql/postgres": patch
---

Preserve raw JSON text for planned node-postgres queries so application JSON validation distinguishes JSON null from SQL NULL, including native JSON arrays and streaming results.
