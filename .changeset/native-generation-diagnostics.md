---
"@typed-sql/cli": patch
---

Report source locations and retained qualification diagnostics when native-required generation
cannot obtain a candidate contract. The underlying classified failure is no longer hidden by
the generic project-wide qualification error; failed generation still preserves durable inputs.
