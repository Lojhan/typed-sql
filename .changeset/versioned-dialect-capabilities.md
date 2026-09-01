---
"@typed-sql/core": minor
"@typed-sql/schema": minor
"@typed-sql/compiler": minor
"@typed-sql/conformance": minor
"@typed-sql/cli": minor
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
"@typed-sql/sqlite": patch
---

Add deterministic versioned dialect capability states backed by normalized server versions,
settings, extensions, and compile options. Query manifests now invalidate on capability changes and
record evidence for capabilities each query uses, while the CLI exposes a human-readable capability
report. The boolean capability map remains available as an additive migration bridge.
