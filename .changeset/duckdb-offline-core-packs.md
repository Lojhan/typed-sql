---
"@typed-sql/duckdb": minor
---

Add bounded, version-specific offline core analyzers and explicit compatibility packs. The core
retains complete selected overload families, operators, native type combinations and codecs;
omitted functions produce an actionable diagnostic and can use qualified native query contracts.
A matching compatibility pack restores the engine's full existing offline rules. Existing analyzer
imports retain their supported behavior. Core imports load neither full catalogs nor native SDKs.
