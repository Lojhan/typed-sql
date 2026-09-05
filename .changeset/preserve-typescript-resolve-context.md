---
"@typed-sql/language-server": patch
---

Retain source snapshot identity through upstream completion, code action, inlay hint and code lens resolution. Preserve upstream opaque data and reject expired or stale resolve requests instead of mapping edits without an owning document.
