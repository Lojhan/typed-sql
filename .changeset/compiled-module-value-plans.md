---
"@typed-sql/compiler": patch
---

Prepare executable query value plans once per module and reuse them across inline query factory calls while preserving directive prologues, original diagnostic locations, and per-call parameter values.
