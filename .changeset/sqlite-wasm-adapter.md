---
"@typed-sql/adapters": minor
---

Add an explicit SQLite Wasm OO1 adapter with lossless INTEGER storage, compiled value-plan decoding, atomic batches and scoped asynchronous transactions. Preserve application ownership of the driver and storage VFS, finalize prepared statements, reject multiple SQL statements before execution, and expose a queryable for SQLite schema introspection.
