---
"@typed-sql/core": patch
"@typed-sql/compiler": patch
"@typed-sql/postgres": patch
"@typed-sql/mysql": patch
"@typed-sql/ts-bridge": patch
---

Infer ordered query parameter tuples and let TypeScript reject interpolation values that do not
match their SQL context. Dialect contract version 2 adds explicit parameter analysis; unresolved
positions remain `unknown`. Add typed nullable predicate composition through `sql.fragment()`,
`sql.and()`, `sql.or()`, `sql.where()`, and `sql.append()` while preserving row and parameter tuples.
Direct append fragments are grammar-analyzed cumulatively against their static base, so TypeScript
rejects fragment interpolation values that disagree with the referenced database columns.
Add `sql.empty` and SQL-template-native conditional structural fragments. The compiler analyzes
complete branch variants, preserves literal boolean-dependent result rows, and type-checks nested
fragment parameters without adding a query-builder DSL. Bound independent structural expansion at
64 variants by default, correlate repeated conditions, merge diagnostics and fragment expectations
across variants, and fail closed on incompatible contexts. Share indexed catalog and conservative
parameter-resolution primitives across grammars, harden cooked-template scanning, and add runtime,
resolver, scanner, and structural performance gates.
