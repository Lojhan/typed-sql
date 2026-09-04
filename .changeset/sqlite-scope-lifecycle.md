---
"@typed-sql/sqlite": patch
---

Prevent child transactions from dispatching after their parent ends, reject overlapping sibling transaction work, and recheck queued work during database shutdown.
