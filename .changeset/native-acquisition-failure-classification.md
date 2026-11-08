---
"@typed-sql/analysis": minor
"@typed-sql/postgres": patch
---

Allow native adapters to classify acquisition failures without host-specific wiring. PostgreSQL
connection loss and temporary availability failures preserve recorded evidence, while confirmed
statement rejection and context changes invalidate it. Acquisition and cleanup failures retain
both classifications so a rollback outage cannot hide a known invalidation.
