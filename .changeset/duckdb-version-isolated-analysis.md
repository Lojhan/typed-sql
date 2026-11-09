---
"@typed-sql/duckdb": minor
---

Add explicit offline analyzer entrypoints for each qualified DuckDB engine. They retain the
selected engine's existing semantics and reject mismatched snapshots while excluding other
engine catalogs from the import graph. The existing analyzer continues to support both engines.

An unresolved generic MAP result now produces conservative analysis instead of dereferencing
missing child type metadata.
