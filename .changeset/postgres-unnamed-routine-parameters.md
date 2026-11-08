---
"@typed-sql/postgres": patch
---

Preserve unnamed routine parameters when PostgreSQL represents their names as empty catalog
entries alongside named parameters. Introspection and selected routine capture retain parameter
positions, modes and named output columns without failing snapshot validation for routines such
as pgcrypto's pgp_armor_headers.
