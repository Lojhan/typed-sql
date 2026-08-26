---
"@typed-sql/core": minor
"@typed-sql/mysql": minor
"@typed-sql/postgres": minor
---

Add grammar-neutral stream and ordered-result type contracts, and add lazy prepared-query factories to the PostgreSQL and MySQL runtime adapters. Prepared factories retain exact query types, validate stable SQL shapes, and remain available inside nested transactions.
