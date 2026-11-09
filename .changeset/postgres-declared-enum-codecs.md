---
"@typed-sql/postgres": patch
---

Derive runtime enum descriptors from schema label metadata for selected columns, parameters,
casts and routine results. String-union policies validate declared labels, including enum-array
elements; string policies retain string representation. Unknown, ambiguous and non-enum type
evidence remains conservative. No native acquisition admission boundary is widened.

Decode driver-returned PostgreSQL array text when the query plan establishes string or enum
elements, and preserve known CASE result families when another branch is a literal SQL NULL.
