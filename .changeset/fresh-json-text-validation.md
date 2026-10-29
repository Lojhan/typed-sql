---
"@typed-sql/core": patch
---

Reduce repeated object checks when validating JSON text parsed inside the decoder. Preserve shape, finite-number and resource limits, and retain full validation for objects supplied by applications or drivers.
