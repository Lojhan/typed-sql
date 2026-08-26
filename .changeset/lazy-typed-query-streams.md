---
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
---

Add lazy, exactly typed query streams to the PostgreSQL and MySQL runtime adapters. PostgreSQL
uses an application-owned optional `pg-cursor` installation for bounded cursor reads. MySQL uses
mysql2's execute-protocol stream and shared decoder plan. Both adapters enforce deterministic
cleanup, transaction ownership, and positive safe-integer batch sizes.
