---
"@typed-sql/mysql": patch
---

Read JSON text from mysql2 and decode it once using the selected JSON policy, preventing BIGINT-safe driver settings from changing JSON numbers into strings. Preserve exact ordinary BIGINT values and add an explicit optional JSON wire fact for custom pools.
