---
"@typed-sql/core": minor
"@typed-sql/postgres": patch
---

Expose grammar-neutral routine argument binding mechanics for generated catalogs and grammar
contributions. PostgreSQL delegates positional, named, default and variadic slot assignment to
the shared contract while retaining its own native type, coercion and overload rules.
