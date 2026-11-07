---
"@typed-sql/sqlserver": patch
---

Keep SQL Server logical type identity separate from physical storage identity. An unqualified
VECTOR type remains unknown instead of being mapped to VARBINARY. Preserve declaration length
defaults while CAST, TRY_CAST, CONVERT and TRY_CONVERT use their contextual length defaults.
