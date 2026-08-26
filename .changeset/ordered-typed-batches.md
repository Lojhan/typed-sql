---
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/core": minor
---

Add a grammar-neutral validated query-batch type and ordered, exactly typed query batches to the
PostgreSQL and MySQL runtime adapters. Non-empty root batches execute sequentially on one leased
connection, transaction batches reuse their transaction connection, and empty batches avoid
connection acquisition. Batch execution preserves prepared metadata and adapter codecs, stops at
the first failure, and rejects transaction work that escapes its callback.
