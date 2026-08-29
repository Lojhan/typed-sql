---
"@typed-sql/language-server": patch
"@typed-sql/ts-bridge": patch
---

Expose a protocol status request, suppress diagnostics from superseded document versions, and verify
the shared editor soundness contract across PostgreSQL, MySQL, and SQLite. The VS Code integration now
uses this standalone server instead of maintaining a second analyzer and preview bridge. Static SQL
navigation now fails closed inside runtime interpolation expressions.
