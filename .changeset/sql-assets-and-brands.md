---
"@typed-sql/core": minor
"@typed-sql/schema": minor
"@typed-sql/compiler": minor
"@typed-sql/cli": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
"@typed-sql/build": patch
"@typed-sql/ts-bridge": patch
---

Include imported SQL assets in query manifests, live verification, plan capture and migration compatibility reports. Discover literal SQL imports from configured TypeScript projects and reject stale or missing sources.

Support named SQL-file parameter objects and repeated or reordered numbered bindings. Preserve grammar-owned lexical rules, original diagnostic spans, bound-value safety and fail-closed checks for mixed styles, gaps and incompatible repeated arguments.

Add explicit scalar column and domain brands through `withSchemaBrands`, `Brand` and `brandValue`. Preserve nominal identities through projections and column-context parameters while retaining primitive runtime conversion and verification contracts.

Escape HTML delimiters and JavaScript line separators in generated SQL-module data literals, preserving original SQL and metadata at runtime.
