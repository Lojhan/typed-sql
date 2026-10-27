---

"@typed-sql/ts-bridge": patch
"@typed-sql/language-server": patch
"@typed-sql/config": patch
---

Use the exact TypeScript 7.1 beta public APIs for editor inference, including initial in-memory snapshots for unsaved documents. Update the language server protocol dependencies and configuration loader dependencies. The compiler remains on its independently verified TypeScript 7.0.2 path.
