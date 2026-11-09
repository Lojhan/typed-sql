---
"@typed-sql/cli": minor
"@typed-sql/compiler": patch
---

Add `check --watch` for ordinary, offline, frozen and explicitly live query checking. Serialize
checks, coalesce edits, reload configuration in each pass, observe discovered external inputs and
ignore disposable cache writes without exporting tracked contracts. Stop owned discovery and
checking processes on shutdown; TypeScript discovery accepts an optional cancellation signal.
