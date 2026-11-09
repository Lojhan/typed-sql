---
"@typed-sql/mysql": minor
---

Add explicit mysql2 query-contract acquisition and independent reconciliation for supported builtin expression projections. Each acquisition owns a read-only connection and backup lock, preserves protocol facets, rejects stored/loadable routines, bounds cancellation and cleanup, and supports recorded offline consumption. Import the native adapter and reconciliation contribution through their explicit development entrypoints; ordinary query imports do not load them or the optional driver.

Preserve geometry results as opaque bytes in owned mysql2 pools so execution matches the grammar's runtime type policy.
