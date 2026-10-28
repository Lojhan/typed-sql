---
"@typed-sql/core": minor
"@typed-sql/compiler": minor
"@typed-sql/postgres": minor
"@typed-sql/mysql": minor
"@typed-sql/sqlite": minor
---

Preserve precise result types for mapped scalar IN lists and scalar INSERT VALUES rows when the selected grammar proves result independence. Keep other repeated expressions conservative, scope cached analysis to its repeated ranges, map result-column locations through expanded SQL, and consume each SQL list delimiter explicitly.
