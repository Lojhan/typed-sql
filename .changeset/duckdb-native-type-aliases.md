---
"@typed-sql/duckdb": patch
---

Recognize DEC, GUID, INTEGRAL, NVARCHAR, OID and TIMESTAMP_US using their native canonical types on both supported engines. Native contract and reconciliation identities advance; regenerate captured DuckDB contracts after upgrading.
