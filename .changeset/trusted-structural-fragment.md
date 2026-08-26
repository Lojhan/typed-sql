---
"@typed-sql/core": patch
"@typed-sql/compiler": patch
"@typed-sql/cli": patch
"@typed-sql/ts-bridge": patch
"@typed-sql/language-server": patch
---

Report `TSQ004` for bare nested templates used as conditional SQL structure and offer an alias-aware
language-server quick fix that prefixes the template with `sql.fragment`. Ordinary and nested
values remain parameterized across the edit.
