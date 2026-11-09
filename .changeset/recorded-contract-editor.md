---
"@typed-sql/language-server": minor
---

Support offline and frozen query contracts in the language server. Covered templates and raw SQL
reuse recorded types without constructing an analyzer or native adapter; hybrid misses use the
configured offline owner. Contract changes invalidate document analysis even when source text
and version are unchanged. Frozen editor analysis ignores disposable cache storage.
