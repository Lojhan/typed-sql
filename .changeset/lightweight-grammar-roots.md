---
"@typed-sql/postgres": major
"@typed-sql/mysql": major
"@typed-sql/sqlite": major
"@typed-sql/sqlserver": major
"@typed-sql/duckdb": major
"@typed-sql/cli": minor
---

Make grammar roots lightweight entrypoints for application SQL, runtime plans, rendering and type
policy. Keep profile construction on explicit `/profile` entrypoints. Move eager analyzer factories
and the previous full root export surfaces to explicit `/analysis` compatibility entrypoints. Application `sql` imports stay at the
selected grammar root. Migrate analyzer, introspection and semantic routing imports to `/analysis`,
or register an explicit lazy analyzer loader alongside a lightweight profile for development hosts.

Scaffold new projects with a lightweight profile and a separate lazy analyzer contribution.
