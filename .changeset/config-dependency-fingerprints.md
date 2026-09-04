---
"@typed-sql/config": patch
---

Avoid rereading unchanged imported configuration files on every project reopen. Cache content hashes behind file identity, size and nanosecond modification/change timestamps; changed or deleted imports still invalidate the configuration.
