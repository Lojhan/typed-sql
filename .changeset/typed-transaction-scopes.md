---
"@typed-sql/core": patch
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
---

Allow adapters to retain enriched capabilities in transaction callbacks and nested transactions
through a self-typed core database contract. Transaction cleanup now also preserves the original
operation error when rollback or connection-release cleanup fails.
