---
"@typed-sql/sqlserver": patch
---

Include explicit database permissions and effective database/server permissions in native query contract context identity. Permission changes invalidate prior context even when the principal and schema stay the same. The native adapter identity changes and previously generated native contracts require regeneration.
