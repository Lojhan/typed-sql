---
"@typed-sql/postgres": minor
---

Add fixed-major and asynchronous PostgreSQL analyzer entrypoints that load only the selected native
routine-signature profile. Share resolver mechanics without eager compatibility imports, preserve
all existing projected signatures and compatibility exports, and reject mismatched snapshot majors.
Shared type/cast registries and the full compatibility distribution remain available.
