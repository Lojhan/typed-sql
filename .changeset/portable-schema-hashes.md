---
"@typed-sql/schema": minor
"@typed-sql/compiler": patch
"@typed-sql/postgres": patch
"@typed-sql/sqlite": patch
---

Make schema and policy hash ordering independent of the host locale, including unordered v2 semantic arrays. Add content-checking compatibility helpers so legacy hashes remain accepted in their originating locale.
