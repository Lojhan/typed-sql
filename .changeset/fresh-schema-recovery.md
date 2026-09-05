---
"@typed-sql/language-server": patch
---

Clear a previously published project-unavailable diagnostic after schema analysis recovers in pull-diagnostic clients. Preserve current TypeScript and SQL diagnostics by refreshing the combined pull report.
