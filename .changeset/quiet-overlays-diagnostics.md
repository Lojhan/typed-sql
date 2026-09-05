---
"@typed-sql/language-server": patch
---

Keep combined TypeScript and SQL diagnostics visible in pull-diagnostic clients such as VS Code. Overlay refresh requests a fresh pull instead of overwriting the report with a SQL-only push; push-only clients retain their existing delivery path.
