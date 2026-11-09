---
"@typed-sql/sqlserver": patch
---

Describe guarded SELECT projections, stars, filters and joins over schema-qualified ordinary local
tables during explicit native query-contract generation. Resolve identifiers as bound metadata,
retain log-quiescence checks, and reject unsupported relation or column capabilities before
description. Include table and security-predicate metadata in context identity. The updated
adapter/profile identity requires regeneration of previous native contracts.
