---
"@typed-sql/analysis": patch
---

Drain pending context cache writes when closing a live analysis session after cancellation. Native context waits remain cancellable, and late native failures cannot publish stale evidence after shutdown.
