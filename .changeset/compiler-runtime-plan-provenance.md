---
"@typed-sql/compiler": patch
---

Reject executable metadata transforms when the query structure cannot receive a runtime value plan, preventing unvalidated application JSON declarations from producing optimistic build output.
