---
"@typed-sql/analysis": minor
"@typed-sql/cli": minor
---

Add exact recorded-context cache lookup before analyzer loading, offline contract-first project
checking, and explicit persistent live producers. Hybrid offline checks load an analyzer only for
uncovered statements; native-required misses and known negative evidence remain conservative.

Fence cache publications across changed static claims and preserve matching recorded evidence on
transport outages. A known stale context blocks all lookups in that recorded context until fresh
qualified acquisition restores it. Explicit live producers always acquire independent evidence.
