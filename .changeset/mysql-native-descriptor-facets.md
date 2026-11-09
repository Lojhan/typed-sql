---
"@typed-sql/mysql": patch
---

Preserve decimal precision/scale and integer signedness in MySQL native verification. Interpret textual and binary protocol fields using their character set, and retain incomplete metadata as unavailable instead of inventing a type. Advance the verification adapter revision for the changed evidence identity.

Use catalog-owned argument bounds for numeric and string-length builtin families, including both supported ATAN forms. Remove contradictory resolver bounds and keep invalid invocations unknown with a diagnostic.
