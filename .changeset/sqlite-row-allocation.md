---
"@typed-sql/sqlite": patch
---

Reduce temporary row-copy allocations in the Node SQLite adapter while preserving storage-value conversion and special column names.

Avoid redundant promise wrappers around synchronous SQLite dispatch and queries without a result validator. Public methods remain asynchronous and use the existing transaction and stream ownership queue.
