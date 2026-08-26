---
"@typed-sql/core": minor
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
---

Cache immutable SQL rendering skeletons for prepared query factories so repeated calls only bind changing values while still rejecting structural drift before driver dispatch.
