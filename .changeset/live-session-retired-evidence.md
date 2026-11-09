---
"@typed-sql/analysis": patch
---

Reacquire and persist live query evidence after cache invalidation or context retirement, including when the newly observed database context has the same identity. Discard scheduler results from the previous evidence generation so refreshed queries remain available after an offline restart.
