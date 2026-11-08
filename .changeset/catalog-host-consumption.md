---
"@typed-sql/analysis": minor
"@typed-sql/cli": minor
"@typed-sql/build": minor
"@typed-sql/language-server": minor
---

Load selected project catalog interpreters lazily in CLI, build and editor hosts, and carry the enriched schema through checking, transforms and declaration generation. Offline checking can reuse qualified declarations for new queries, while frozen checking requires exact contracts. Preserve base-context retirement evidence when checking derived catalog inputs, and track catalog objects and local interpreter modules as dependencies.
