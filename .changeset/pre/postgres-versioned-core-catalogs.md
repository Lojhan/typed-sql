---
"@typed-sql/postgres": minor
---

Add deterministic generated PostgreSQL core catalogs for every supported major and the canary.
Type mapping, operator families, and built-in routine families now resolve from one version-selected
catalog revision instead of parallel hard-coded resolver lists.
