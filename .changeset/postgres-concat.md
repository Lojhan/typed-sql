---
"@typed-sql/postgres": patch
---
Recognize PostgreSQL CONCAT with ordinary positional arguments. Infer nonnullable text while ignoring NULL inputs, retain typed parameters, and diagnose unresolved inputs or unsupported VARIADIC forms.
