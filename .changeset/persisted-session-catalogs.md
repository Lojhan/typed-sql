---
"@typed-sql/analysis": minor
"@typed-sql/cli": minor
"@typed-sql/language-server": minor
---

Persist selected catalog closures in the owned analysis cache with independent base-context and
selection publication fences. Live editor sessions capture through a shared native owner, reuse
valid document views, and bound refresh work, cancellation and cleanup. Offline checks recover
matching cached selections with independently installed interpreters. Explicit live CLI checks
can capture selected catalogs without exporting durable artifacts.
