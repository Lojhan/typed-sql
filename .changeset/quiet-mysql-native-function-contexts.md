---
"@typed-sql/mysql": patch
---

Apply version-owned keyword reservation and function-name parsing rules from pinned declarations. Preserve native distinctions for quoting, whitespace, IGNORE_SPACE and Unicode lookalikes instead of assigning unrelated built-in semantics. Ordinary routine calls retain argument inference and require suitable metadata. Retire contracts from preceding interpretation rules.
