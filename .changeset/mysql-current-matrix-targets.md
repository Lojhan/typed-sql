---
"@typed-sql/mysql": patch
---

Align the published MySQL support evidence with the exact currently available Docker Official Image patches for the 8.4 and 9.7 LTS lines and the 26.7 innovation canary. Keep typed bulk loading portable across modeled SQL modes by expressing field, escape, and line delimiters as hexadecimal SQL literals instead of mode-sensitive escaped strings.
