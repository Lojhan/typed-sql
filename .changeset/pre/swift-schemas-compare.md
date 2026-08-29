---
"@typed-sql/core": major
"@typed-sql/compiler": major
"@typed-sql/cli": major
---

Add deterministic migration compatibility analysis across before/after schema snapshots and query
manifests. Reports classify both rolling-deployment directions, retain exact source and dependency
evidence, fail closed for unknown semantics, redact defaults and paths, and support configurable CI
severity through `typed-sql compat`.
