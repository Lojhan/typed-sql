---
"@typed-sql/core": minor
"@typed-sql/schema": minor
"@typed-sql/compiler": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
---

Add canonical schema snapshot format 2 with isolated v1/v2 codecs, conservative v1 upgrades,
neutral relation/constraint/index/type/routine evidence, and complete provider introspection.
Resolvers now consume structural write and routine evidence, while drift, compatibility, manifests,
verification proofs, and plan artifacts bind to the schema format and canonical hash.
