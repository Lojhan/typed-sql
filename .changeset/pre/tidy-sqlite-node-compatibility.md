---
"@typed-sql/sqlite": patch
---

Support Node.js 22.11 and 22.12 by normalizing file URLs before opening `DatabaseSync` and using a
buffered iterator when those Node releases do not yet provide `StatementSync.iterate()`.
