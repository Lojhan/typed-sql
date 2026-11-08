---
"@typed-sql/analysis": patch
"@typed-sql/language-server": patch
"@typed-sql/duckdb": patch
---

Keep active query views valid when live database observations confirm an unchanged context. Observation timestamps still refresh, while catalog changes, retirement and invalidation retain their publication fences. This avoids spurious unavailable editor diagnostics when context refresh overlaps query preparation.

Require consistent builtin scalar families for DuckDB native expression acquisition. Session-dependent binding results require separate qualification. Advance the adapter/profile revision so previously captured contracts cannot bypass this admission change.
