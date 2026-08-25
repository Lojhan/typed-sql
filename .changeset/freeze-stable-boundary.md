---
"@typed-sql/core": patch
"@typed-sql/ast": patch
"@typed-sql/schema": patch
"@typed-sql/config": patch
"@typed-sql/compiler": patch
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
"@typed-sql/cli": patch
"@typed-sql/ts-bridge": patch
"@typed-sql/language-server": patch
---

Declare and enforce the 1.0 package stability boundary. Core SQL, compiler, schema, config, AST,
PostgreSQL, MySQL, and CLI packages form the stable train; the TypeScript preview bridge and
language server remain explicitly experimental. Freeze public entrypoints and query type contracts,
and remove internal compiler/type helpers from stable package-root exports before 1.0.
