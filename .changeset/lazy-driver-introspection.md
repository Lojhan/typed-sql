---
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
"@typed-sql/sqlite": patch
"@typed-sql/sqlserver": patch
"@typed-sql/duckdb": patch
---

Keep execution adapter imports independent of schema discovery and semantic catalogs. Share cold
provider and extension contracts, preserve server/session evidence checks in dedicated modules, and
load introspection implementations only when requested. PostgreSQL extension-manifest validation
retains its explicit opt-in semantic resolution path and existing error identity.
