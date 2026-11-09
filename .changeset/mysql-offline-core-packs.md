---
"@typed-sql/mysql": minor
---

Add selected-series full analyzers, bounded offline cores and explicit compatibility packs.
Core imports retain shared type, coercion, collation, JSON and selected routine-family rules
without loading unrelated full catalogs or introspection services. Omitted routine rules retain
parameter evidence and produce an actionable diagnostic that qualified native generation can
resolve. Version, edition and SQL-mode errors remain blocking. Existing analyzer imports preserve
the full offline behavior, and canary selection still requires the canary version policy.
