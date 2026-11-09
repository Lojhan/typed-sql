---
"@typed-sql/analysis": patch
---

Observe native context again when a shared cache publication fence changes, even inside the context observation interval. Fresh views use the new fence while earlier views remain invalidated.

Automatically scoped live sessions also retry explicitly classified acquisition drift up to three times with fresh context observations under one batch deadline. Explicit context pins remain fixed, and failed native leases close before another attempt.
