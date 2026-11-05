---
"@typed-sql/core": patch
"@typed-sql/compiler": patch
---

Allow grammar-owned live verifiers to compare physical database types even when their JavaScript types match. Missing or unavailable native evidence cannot produce a verified proof.

Bind cached verification proofs to the optional native-type comparison capability. Verifiers requiring physical comparison reject older coarse proofs until native verification runs again.
