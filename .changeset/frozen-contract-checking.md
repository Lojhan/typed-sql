---
"@typed-sql/core": minor
"@typed-sql/config": minor
"@typed-sql/analysis": minor
"@typed-sql/compiler": minor
"@typed-sql/cli": minor
"@typed-sql/postgres": minor
---

Add lightweight dialect registrations with explicit lazy analyzer loading and frozen CLI checks
against validated durable query contracts. Frozen checks validate interpreter, schema, decoding and
qualification identities without opening disposable caches, initializing analyzers or invoking
database providers. TypeScript project checking supplies SQL-file factory declarations in memory.

Expose PostgreSQL contract compatibility identities through a pure contract-profile entrypoint.
