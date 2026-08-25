---
"@typed-sql/compiler": patch
"@typed-sql/mysql": patch
"@typed-sql/language-server": patch
---

Replace potentially expensive parser regular expressions with bounded scanners, tighten editor
completion matching, and prevent releases while high-severity CodeQL alerts remain open.
