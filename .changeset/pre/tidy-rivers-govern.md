---
"@typed-sql/core": major
"@typed-sql/postgres": major
"@typed-sql/mysql": major
---

Add grammar-neutral `all`, `one`, and `maybeOne` execution with exact row types, stable cardinality
and cancellation errors, explicit adapter capabilities, AbortSignal support, and absolute deadlines.
The pg and mysql2 adapters conservatively discard interrupted connections, including transaction
leases, while the existing uncontrolled `execute` path remains unchanged.
