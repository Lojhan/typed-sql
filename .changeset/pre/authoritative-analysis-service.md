---
"@typed-sql/core": minor
"@typed-sql/compiler": minor
"@typed-sql/ts-bridge": minor
"@typed-sql/language-server": patch
---

Add the versioned, serializable source-analysis service shared by batch checks and editor tooling.
Results carry deterministic source, project, schema, type-policy, grammar, and capability identities;
cancellation and source, query-count, structural-variant, and generated-declaration limits fail closed.
