---
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
---

Load compact generated type-policy projections instead of full semantic catalogs in PostgreSQL
and MySQL codec helpers. Preserve existing version selection, native names, aliases and mappings;
PostgreSQL runtime compatibility retains the same catalog revision checks. Share type-name
normalization with the analyzers so runtime and compile-time policy remain aligned.
