---
"@typed-sql/core": patch
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
---

Enforce attached compiled value plans across buffered, prepared, batch, transaction, and streaming execution, including PostgreSQL pipelines. Encode JSON parameters as JSON text before driver binding, reject incompatible policies before dispatch, and validate planned results before application result schemas. Preserve MySQL JSON numeric text when the string policy is selected.
