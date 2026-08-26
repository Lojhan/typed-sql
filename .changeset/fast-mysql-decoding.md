---
"@typed-sql/mysql": patch
---

Compile MySQL result-field decoders once per result and avoid copying rows when runtime type-policy
decoding does not change their values. This removes repeated field scans and makes buffered decoding
scale linearly with result width.
