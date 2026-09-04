---
"@typed-sql/mysql": patch
---

Discard transaction connections after failed rollback or savepoint recovery, preserve the original error, and prevent an invalidated parent from committing or dispatching further work.
