---
"@typed-sql/analysis": patch
---

Preserve retired database contexts across later retirements and cache capacity handling. When individual retirement history exceeds the configured bounds, require fresh context observation for unrecorded scopes instead of allowing old durable evidence to become eligible again.
