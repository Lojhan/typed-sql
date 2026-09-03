---
"@typed-sql/core": minor
"@typed-sql/mysql": minor
"@typed-sql/conformance": patch
---

Add neutral column charset and collation evidence, generated versioned MySQL built-in catalogs,
catalog-backed type and function availability, MySQL collation coercibility, and signed/unsigned
numeric expression resolution.
Conformance v2 now compares grammar analysis against the neutral resolved-column contract while
allowing grammar-owned result evidence.
