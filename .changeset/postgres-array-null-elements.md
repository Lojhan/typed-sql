---
"@typed-sql/postgres": patch
---

Include null elements in catalog-backed PostgreSQL array types. PostgreSQL permits null elements independently of column nullability; literal array expressions can retain more precise element evidence.
