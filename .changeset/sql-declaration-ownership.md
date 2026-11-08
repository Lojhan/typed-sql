---
"@typed-sql/compiler": patch
"@typed-sql/build": patch
---

Accept current build-generated SQL declarations during project checking by sharing the declaration
ownership header and normalizing platform line endings. Continue rejecting changed or stale
declaration contents, including files carrying the generated ownership header.
