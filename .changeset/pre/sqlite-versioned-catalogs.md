---
"@typed-sql/core": patch
"@typed-sql/sqlite": minor
---

Resolve SQLite core built-ins, operators, coercions, arities, nullability, and in-band function
release boundaries from SQLite-owned catalog data. Add a stable diagnostic for invalid SQLite
built-in invocations and fail closed when version-gated functions lack usable server evidence.
