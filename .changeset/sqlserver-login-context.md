---
"@typed-sql/sqlserver": patch
---

Bind native query contracts to the original/current login and database-user identities, including SIDs. Missing identity metadata declines acquisition. Regenerate earlier SQL Server native contracts after this adapter identity change.
