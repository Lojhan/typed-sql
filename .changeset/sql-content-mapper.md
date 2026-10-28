---
"@typed-sql/core": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
"@typed-sql/ts-bridge": minor
---

Add an optional grammar-owned parameter occurrence contract and an experimental TypeScript 7.1
content mapper for SQL-file query factories. The mapper checks positional parameters and result
rows against the configured offline snapshot, reports original SQL diagnostics, and refreshes
configuration dependencies in native watch mode. An optional Node.js 24 preload executes the same
SQL files through the existing branded query and database APIs.
