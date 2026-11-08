---
"@typed-sql/duckdb": minor
---

Add fixed-version and asynchronous selected analyzer entrypoints. Selected analyzers load only their exact engine's signatures, formal parameter bindings, implicit casts and common-type rules, and reject mismatched snapshot evidence. Keep the full compatibility analyzer and its automatic version selection available.
