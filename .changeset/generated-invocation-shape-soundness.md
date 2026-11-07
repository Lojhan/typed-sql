---
"@typed-sql/duckdb": patch
---

Preserve quoted expression identifiers, reject ambiguous and invalid function bindings, and handle unresolved MAP results without crashing. Generate literal-argument constraints from semantic policy, native parameter names and aliases. Validate range table-function overloads, infer qualified timestamp results, and report constant-NULL table bindings as unsupported when native overload-cost evidence is missing.
