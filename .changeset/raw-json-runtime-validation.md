---
"@typed-sql/core": patch
"@typed-sql/mysql": patch
---

Validate application-declared JSON before driver decoding can conflate JSON null with SQL NULL. Preserve JSON text through planned MySQL queries and validate structured JSON elements inside native SQL arrays. Reject parsed transports that cannot establish the declared contract.
