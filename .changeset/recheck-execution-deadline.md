---
"@typed-sql/core": patch
---

Recheck the requested deadline when its timer fires. Early timer delivery no longer cancels native work before the deadline, keeping adapter cancellation and clock checks consistent.
