---
"@typed-sql/postgres": minor
---

Add a separate pure native/static reconciliation contribution for PostgreSQL. Compare successful
offline inference independently, preserve nullability uncertainty and reject inconsistent type
claims. Native acquisition now restricts inferred representations to qualified built-in base
types and records namespace/kind evidence instead of trusting custom mappings in a schema input.
