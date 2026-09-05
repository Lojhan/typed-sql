---
"@typed-sql/language-server": patch
---

Keep diagnostic pulls recoverable when schema analysis fails during a request, and request a retry for stale diagnostic snapshots instead of allowing an empty report to replace current errors.
