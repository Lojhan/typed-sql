---
"@typed-sql/core": major
"@typed-sql/compiler": major
"@typed-sql/ast": minor
"@typed-sql/schema": minor
"@typed-sql/postgres": major
"@typed-sql/mysql": major
---

Add the dialect contract v4 semantic query evidence foundation. PostgreSQL and MySQL now report operation, dependencies, cardinality, volatility, locking, connection affinity, and required capabilities; compiler results add deterministic query and structural-variant fingerprints and conservatively merged source-mapped semantics. Schema snapshots can record function volatility, and the AST package exposes a neutral statement walker for grammar implementations.
