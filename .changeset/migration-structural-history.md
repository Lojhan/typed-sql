---
"@typed-sql/migrations": patch
"@typed-sql/postgres": patch
---
Add optional historical catalog display details with validated object identities. PostgreSQL targets can opt in with captureDetails to retain safe structural column, enum, index and constraint metadata while preserving existing drift fingerprints and hash-only history. Routine bodies, default literals and expression SQL remain excluded.
