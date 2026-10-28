---
"@typed-sql/adapters": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
---

Add explicit buffered adapters for D1, libSQL/Turso, Neon HTTP, Neon WebSocket, and Postgres.js.
Adapters enforce compiled value plans, transport precision, and truthful batch/transaction
capabilities while leaving drivers application-owned. Add portable grammar query entrypoints and
logical value descriptors without changing existing runtime entrypoint exports.
