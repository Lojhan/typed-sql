---
"@typed-sql/analysis": patch
---

Keep a live context request's deadline active until the request settles. A noncooperative adapter
cannot leave an unresolved request when no other socket or timer keeps the process alive. Clear
owned timers after success, failure or cancellation.
