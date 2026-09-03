---
"@typed-sql/core": minor
"@typed-sql/compiler": minor
"@typed-sql/conformance": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
---

Allow non-empty arrays of typed SQL fragments to be interpolated directly as homogeneous,
comma-separated structure. Add fail-closed compiler analysis for direct map callbacks and fragment
literals, cardinality-independent artifacts, bounded prepared-cardinality caches, shared grammar
conformance, and runtime limits while preserving ordinary arrays as single bound values.
